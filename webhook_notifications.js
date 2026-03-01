const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n')
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL
  });
}

const db = admin.database();

// Google Play notification types
const NOTIFICATION_TYPES = {
  PURCHASE_CANCELED: 2,
  PURCHASE_REFUNDED: 12,
  PURCHASE_REVOKED: 13
};

// Deduct coins safely
async function deductCoinsFromUser(userId, coins, reason) {
  const userRef = db.ref(`users/${userId}/diamonds`);
  const snapshot = await userRef.once('value');

  const currentCoins = snapshot.val() || 0;
  const newCoins = Math.max(0, currentCoins - coins);

  await db.ref().update({
    [`users/${userId}/diamonds`]: newCoins,
    [`users/${userId}/lastRefund`]: Date.now(),
    [`users/${userId}/refundCount`]: admin.database.ServerValue.increment(1)
  });

  await db.ref('refund_logs').push({
    userId,
    coinsDeducted: coins,
    previousBalance: currentCoins,
    newBalance: newCoins,
    reason,
    timestamp: Date.now()
  });

  return { previousBalance: currentCoins, newBalance };
}

// Handle refund / revoke
async function handleRefund(purchaseToken, notificationType) {
  const purchasesSnap = await db.ref('processed_purchases')
    .orderByChild('purchaseToken')
    .equalTo(purchaseToken)
    .once('value');

  if (!purchasesSnap.exists()) {
    console.log('Purchase not found:', purchaseToken);
    return;
  }

  const purchaseId = Object.keys(purchasesSnap.val())[0];
  const purchase = purchasesSnap.val()[purchaseId];

  if (purchase.refunded) {
    console.log('Already refunded:', purchaseId);
    return;
  }

  const { userId, coins, productId, orderId } = purchase;
  const reason =
    notificationType === NOTIFICATION_TYPES.PURCHASE_REFUNDED
      ? 'Refund'
      : 'Purchase Revoked';

  const deduction = await deductCoinsFromUser(userId, coins, reason);

  // Mark purchase refunded
  await db.ref(`processed_purchases/${purchaseId}`).update({
    refunded: true,
    refundedAt: Date.now(),
    refundReason: reason
  });

  // 🔥 Write refund record (NEW)
  const refundRef = db.ref(`refunds/${userId}`).push();
  await refundRef.set({
    refundId: refundRef.key,
    userId,
    orderId,
    productId,
    coins,
    reason,
    purchaseToken,
    notificationType,
    previousBalance: deduction.previousBalance,
    newBalance: deduction.newBalance,
    timestamp: Date.now()
  });

  // Ban user if abusing refunds
  const refundCountSnap = await db.ref(`users/${userId}/refundCount`).once('value');
  const refundCount = refundCountSnap.val() || 1;

  if (refundCount >= 3) {
    await db.ref(`users/${userId}`).update({
      isBanned: true,
      banReason: 'Multiple refunds detected',
      bannedAt: Date.now()
    });

    // Log ban as refund event
    await db.ref(`refunds/${userId}/${refundRef.key}`).update({
      userBanned: true,
      banReason: 'Multiple refunds'
    });
  }

  console.log(`✅ Refund handled for order ${orderId}`);
}

// Main webhook
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const message = req.body.message;
    if (!message?.data) {
      return res.status(400).json({ error: 'Invalid format' });
    }

    const decoded = Buffer.from(message.data, 'base64').toString('utf8');
    const notification = JSON.parse(decoded);

    console.log('Notification received:', notification);

    // Test notification
    if (notification.testNotification) {
      console.log('✅ Test notification OK');
      return res.status(200).json({ success: true });
    }

    const otp = notification.oneTimeProductNotification;
    if (!otp) {
      return res.status(200).json({ success: true });
    }

    const { notificationType, purchaseToken } = otp;

    if (
      notificationType === NOTIFICATION_TYPES.PURCHASE_REFUNDED ||
      notificationType === NOTIFICATION_TYPES.PURCHASE_REVOKED
    ) {
      await handleRefund(purchaseToken, notificationType);
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).json({ success: false });
  }
};

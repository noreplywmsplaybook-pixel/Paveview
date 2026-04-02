window.paveviewSubscriptionSync = (function () {
  function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isTrialPurchase(purchase) {
    const product = String(purchase?.product || '').toLowerCase();
    const hasExplicitFreeAmount = purchase?.amount_paid !== null
      && purchase?.amount_paid !== undefined
      && Number(purchase?.amount_paid) === 0;
    return product.includes('trial') || hasExplicitFreeAmount;
  }

  async function fetchActivePurchases(sb, userId) {
    const { data, error } = await sb
      .from('purchases')
      .select('id,product,status,amount_paid,created_at')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(20);

    return {
      purchases: Array.isArray(data) ? data : [],
      error: error || null
    };
  }

  function getStripeSessionIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return (
      params.get('session_id')
      || params.get('stripe_session_id')
      || params.get('checkout_session_id')
      || ''
    );
  }

  async function syncPaidUpgrade(sb, session, purchases) {
    if (!sb || !session?.user?.id || !session?.access_token) {
      return Array.isArray(purchases) ? purchases : [];
    }

    const activePurchases = Array.isArray(purchases) ? purchases : [];
    if (activePurchases.some((purchase) => !isTrialPurchase(purchase))) {
      return activePurchases;
    }
    if (!activePurchases.some(isTrialPurchase)) {
      return activePurchases;
    }

    try {
      const resp = await fetch('/api/trial-upgrade', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          userId: session.user.id,
          email: normalizeEmail(session.user.email || ''),
          stripeSessionId: getStripeSessionIdFromUrl()
        })
      });

      if (!resp.ok) return activePurchases;

      const refreshed = await fetchActivePurchases(sb, session.user.id);
      if (refreshed.error) return activePurchases;
      return refreshed.purchases;
    } catch (error) {
      return activePurchases;
    }
  }

  return {
    fetchActivePurchases,
    syncPaidUpgrade
  };
})();

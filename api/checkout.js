const Stripe = require('stripe');
const { supabase, getUser, getProfile } = require('./_lib/supabase');
const { getJsonBody } = require('./_lib/body');

const PRICE_IDS = {
  pro: process.env.STRIPE_PRO_PRICE_ID,
  unlimited: process.env.STRIPE_UNLIMITED_PRICE_ID
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  let body;
  try {
    body = await getJsonBody(req);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const { plan } = body;
  if (!plan || !PRICE_IDS[plan]) {
    return res.status(400).json({ error: 'plan must be "pro" or "unlimited"' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const name = user.user_metadata?.name || user.user_metadata?.full_name;
  const profile = await getProfile(user.id, user.email, name);

  // Get or create Stripe customer
  let customerId = profile?.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      name: profile?.name,
      metadata: { supabase_id: user.id }
    });
    customerId = customer.id;
    await supabase
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', user.id);
  }

  // Determine origin for redirect URLs
  const origin =
    (req.headers.origin && req.headers.origin !== 'null')
      ? req.headers.origin
      : 'https://writemylyrics.ai';

  try {
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: PRICE_IDS[plan], quantity: 1 }],
      success_url: `${origin}/?checkout=success&plan=${plan}`,
      cancel_url: `${origin}/?checkout=cancel`,
      allow_promotion_codes: true,
      metadata: { supabase_id: user.id, plan }
    });

    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error('Stripe checkout error:', e);
    return res.status(500).json({ error: e.message });
  }
};

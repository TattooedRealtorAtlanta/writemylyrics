const Stripe = require('stripe');
const { supabase } = require('./_lib/supabase');
const { getRawBody } = require('./_lib/body');

const PLAN_FROM_PRICE = {
  [process.env.STRIPE_PRO_PRICE_ID]: 'pro',
  [process.env.STRIPE_UNLIMITED_PRICE_ID]: 'unlimited'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];

  // Must read raw body before any JSON parsing for signature verification
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Could not read request body' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error('Webhook signature error:', e.message);
    return res.status(400).json({ error: `Webhook error: ${e.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { supabase_id, plan } = session.metadata || {};
        if (supabase_id && plan) {
          await supabase
            .from('profiles')
            .update({
              plan,
              stripe_subscription_id: session.subscription
            })
            .eq('id', supabase_id);
        }
        break;
      }

      case 'customer.subscription.updated': {
        // Handle plan changes made directly in Stripe dashboard
        const sub = event.data.object;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const newPlan = PLAN_FROM_PRICE[priceId];
        if (newPlan && sub.status === 'active') {
          await supabase
            .from('profiles')
            .update({ plan: newPlan })
            .eq('stripe_subscription_id', sub.id);
        }
        break;
      }

      case 'customer.subscription.deleted': {
        // Subscription cancelled — downgrade to free
        const sub = event.data.object;
        const { data: rows } = await supabase
          .from('profiles')
          .select('id')
          .eq('stripe_subscription_id', sub.id);

        if (rows?.length) {
          await supabase
            .from('profiles')
            .update({ plan: 'free', stripe_subscription_id: null })
            .eq('stripe_subscription_id', sub.id);
        }
        break;
      }

      default:
        // Unhandled event type — acknowledge and move on
        break;
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }

  return res.status(200).json({ received: true });
};

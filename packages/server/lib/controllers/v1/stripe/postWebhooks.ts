import { billing } from '@nangohq/billing';
import db from '@nangohq/database';
import { accountService, getPlanBy, plansList, productTracking, updatePlan, updatePlanByTeam } from '@nangohq/shared';
import { Err, Ok, getLogger, report } from '@nangohq/utils';

import { envs } from '../../../env.js';
import { asyncWrapper } from '../../../utils/asyncWrapper.js';
import { getStripe } from '../../../utils/stripe.js';

import type { DBPlan, PostStripeWebhooks, Result } from '@nangohq/types';
import type Stripe from 'stripe';

const logger = getLogger('Server.Stripe');

/**
 * Stripe is sending webhook on checkout and subscription created.
 * Without this we can't link a payment to an account in our backend
 *
 * Forward locally with:
 * stripe listen --load-from-webhooks-api --forward-to localhost:3003
 */
export const postStripeWebhooks = asyncWrapper<PostStripeWebhooks>(async (req, res) => {
    if (!envs.STRIPE_SECRET_KEY || !envs.STRIPE_WEBHOOKS_SECRET) {
        res.status(403).send({ error: { code: 'feature_disabled', message: 'feature disabled' } });
        return;
    }

    const sig = req.headers['stripe-signature'];
    if (!sig || typeof sig !== 'string') {
        report(new Error('[stripe] No signature'));
        res.status(403).send({ error: { code: 'forbidden', message: 'no signature' } });
        return;
    }

    const stripe = getStripe();

    let event: Stripe.Event;
    try {
        event = stripe.webhooks.constructEvent(req.rawBody!, sig, envs.STRIPE_WEBHOOKS_SECRET);
    } catch (err) {
        report(err);
        res.status(403).send({ error: { code: 'forbidden', message: 'signature does not match' } });
        return;
    }

    logger.info('Received', event.type);
    const handled = await handleWebhook(event, stripe);
    if (handled.isErr()) {
        report(handled.error, { body: req.body });
        res.status(500).send({ error: { code: 'server_error', message: handled.error.message } });
        return;
    }

    res.status(200).send({ success: true });
});

async function handleWebhook(event: Stripe.Event, stripe: Stripe): Promise<Result<void>> {
    switch (event.type) {
        // card was created through our UI
        case 'setup_intent.succeeded': {
            const data = event.data.object;
            if (typeof data.customer !== 'string') {
                return Err('missing customer in data');
            }

            const resPlan = await getPlanBy(db.knex, { stripe_customer_id: data.customer });
            if (resPlan.isErr()) {
                return Err(resPlan.error);
            }

            logger.info(`Payment method collected for account ${resPlan.value.account_id}`);

            const plan = resPlan.value;
            const updated = await updatePlan(db.knex, { id: plan.id, stripe_payment_id: data.payment_method as string });
            if (updated.isErr()) {
                return Err(updated.error);
            }

            return Ok(undefined);
        }

        // payment method was updated through our UI
        // we replicate to the customer to keep it in sync and to be able to generate invoices
        // It might be incorrect in some cases, but it's better than nothing
        case 'payment_method.updated': {
            const data = event.data.object;
            if (typeof data.customer !== 'string') {
                return Err('missing customer in data');
            }

            const paymentMethod = await stripe.paymentMethods.retrieve(event.data.object.id);
            const billingDetails = paymentMethod.billing_details;

            await stripe.customers.update(data.customer, {
                address: billingDetails.address as any,
                name: billingDetails.name || ''
            });
            return Ok(undefined);
        }

        // card was deleted through the UI or via stripe directly
        case 'payment_method.detached': {
            const customer = event.data.previous_attributes?.customer;
            if (typeof customer !== 'string') {
                return Err('missing customer in data');
            }

            const resPlan = await getPlanBy(db.knex, { stripe_customer_id: customer });
            if (resPlan.isErr()) {
                return Err(resPlan.error);
            }

            logger.info(`Payment method removed for account ${resPlan.value.account_id}`);

            const plan = resPlan.value;
            if (plan.stripe_payment_id && plan.stripe_payment_id === event.data.object.id) {
                // Only delete if it's the same main payment method
                const updated = await updatePlan(db.knex, { id: plan.id, stripe_payment_id: null });
                if (updated.isErr()) {
                    return Err(updated.error);
                }
            }

            return Ok(undefined);
        }

        // payment intent from upgrade has been successful
        case 'payment_intent.succeeded': {
            const data = event.data.object;
            const customer = data.customer;
            if (typeof customer !== 'string') {
                return Err('missing customer in data');
            }

            const resPlan = await getPlanBy(db.knex, { stripe_customer_id: customer });
            if (resPlan.isErr()) {
                return Err(resPlan.error);
            }

            const plan = resPlan.value;
            logger.info(`Payment received for account ${plan.account_id} ${data.amount / 100}$`);

            // We want to continue our plan upgrade
            const resSub = await billing.getSubscription(plan.account_id);
            if (resSub.isErr()) {
                return Err(resSub.error);
            }

            const sub = resSub.value;
            if (!sub || !sub.pendingChangeId) {
                return Err("team doesn't not have a subscription or pending changes");
            }

            // Finally, we apply the pending change to confirm the card and the plan
            const resApply = await billing.client.applyPendingChanges({
                pendingChangeId: sub.pendingChangeId,
                amount: (data.amount / 100).toFixed(2)
            });
            if (resApply.isErr()) {
                return Err(resApply.error);
            }

            // This operation is also done in orb/postWebhooks
            // But their webhook system is so slow that we need to duplicate the logic here
            return await db.knex.transaction(async (trx) => {
                const team = await accountService.getAccountById(trx, plan.account_id);
                if (!team) {
                    return Err('Failed to find team');
                }

                const planExternalId = resApply.value.planExternalId;
                const exists = plansList.find((p) => p.orbId === planExternalId);
                if (!exists) {
                    return Err('Received a plan not linked to the plansList');
                }

                const updated = await updatePlanByTeam(trx, {
                    account_id: team.id,
                    name: planExternalId as unknown as DBPlan['name'],
                    orb_subscription_id: resApply.value.id,
                    orb_future_plan: null,
                    orb_future_plan_at: null,
                    ...exists.flags
                });
                if (updated.isErr()) {
                    return Err('Failed to updated plan');
                }

                productTracking.track({
                    name: 'account:billing:plan_changed',
                    team,
                    eventProperties: { previousPlan: plan.name, newPlan: planExternalId, orbCustomerId: plan.orb_customer_id }
                });

                logger.info(`Plan updated for account ${team.id} to ${planExternalId}`);

                return Ok(undefined);
            });
        }

        // payment intent from upgrade has not been successful
        case 'payment_intent.canceled':
        case 'payment_intent.payment_failed': {
            const data = event.data.object;
            const customer = data.customer;
            if (typeof customer !== 'string') {
                return Err('missing customer in data');
            }

            const resPlan = await getPlanBy(db.knex, { stripe_customer_id: customer });
            if (resPlan.isErr()) {
                return Err(resPlan.error);
            }

            logger.info(`Payment failed for account ${resPlan.value.account_id} ${data.amount / 100}$`);

            // We want to cancel our plan upgrade
            const resSub = await billing.getSubscription(resPlan.value.account_id);
            if (resSub.isErr()) {
                return Err(resSub.error);
            }
            const sub = resSub.value;
            if (!sub || !sub.pendingChangeId) {
                return Err("team doesn't not have a subscription or pending changes");
            }

            const resCancel = await billing.client.cancelPendingChanges({
                pendingChangeId: sub.pendingChangeId
            });
            if (resCancel.isErr()) {
                return Err(resCancel.error);
            }

            return Ok(undefined);
        }

        default:
            return Ok(undefined);
    }
}

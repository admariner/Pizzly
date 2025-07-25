import * as z from 'zod';

import { requireEmptyQuery, zodErrorToHTTP } from '@nangohq/utils';

import { asyncWrapper } from '../../../../utils/asyncWrapper.js';
import { bodySchema as originalBodySchema, generateSession } from '../../../connect/postSessions.js';

import type { PostConnectSessions, PostInternalConnectSessions } from '@nangohq/types';

const bodySchema = z
    .object({
        allowed_integrations: originalBodySchema.shape.allowed_integrations,
        end_user: originalBodySchema.shape.end_user,
        organization: originalBodySchema.shape.organization
    })
    .strict();

export const postInternalConnectSessions = asyncWrapper<PostInternalConnectSessions>(async (req, res) => {
    const valQuery = requireEmptyQuery(req, { withEnv: true });
    if (valQuery) {
        res.status(400).send({ error: { code: 'invalid_query_params', errors: zodErrorToHTTP(valQuery.error) } });
        return;
    }

    const valBody = bodySchema.safeParse(req.body);
    if (!valBody.success) {
        res.status(400).send({ error: { code: 'invalid_body', errors: zodErrorToHTTP(valBody.error) } });
        return;
    }

    const body: PostInternalConnectSessions['Body'] = valBody.data;

    // req.body is never but we want to fake it on purpose

    const emulatedBody = {
        allowed_integrations: body.allowed_integrations,
        end_user: body.end_user,
        organization: body.organization
    } satisfies PostConnectSessions['Body'];

    await generateSession(res, emulatedBody);
});

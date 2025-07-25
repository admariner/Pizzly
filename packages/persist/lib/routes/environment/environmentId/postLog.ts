import * as z from 'zod';

import { logContextGetter, operationIdRegex } from '@nangohq/logs';
import { validateRequest } from '@nangohq/utils';

import type { AuthLocals } from '../../../middleware/auth.middleware.js';
import type { MessageRowInsert, PostLog } from '@nangohq/types';
import type { EndpointRequest, EndpointResponse, Route, RouteHandler } from '@nangohq/utils';

const MAX_LOG_CHAR = 10000;

export const logBodySchema = z.object({
    activityLogId: operationIdRegex,
    log: z.object({
        type: z.enum(['log', 'http']),
        message: z.string(),
        source: z.enum(['internal', 'user']).optional().default('internal'),
        level: z.enum(['debug', 'info', 'warn', 'error']),
        error: z
            .object({
                name: z.string(),
                message: z.string(),
                type: z.string().optional(),
                payload: z.any().optional()
            })
            .optional(),
        request: z
            .object({
                url: z.string(),
                method: z.string(),
                headers: z.record(z.string(), z.string())
            })
            .optional(),
        response: z
            .object({
                code: z.number(),
                headers: z.record(z.string(), z.string())
            })
            .optional(),
        meta: z.record(z.string(), z.any()).optional().nullable(),
        createdAt: z.string(),
        endedAt: z.string().optional(),
        durationMs: z.number().optional(),
        context: z.enum(['script', 'proxy']).optional(),
        retry: z.object({ max: z.number(), waited: z.number(), attempt: z.number() }).optional()
    })
});

const validate = validateRequest<PostLog>({
    parseBody: (data) => {
        return logBodySchema.strict().parse(data);
    },
    parseParams: (data) =>
        z
            .object({
                environmentId: z.coerce.number().int().positive()
            })
            .strict()
            .parse(data)
});

const handler = (_req: EndpointRequest, res: EndpointResponse<PostLog, AuthLocals>) => {
    const { account, parsedBody: body } = res.locals;

    const truncate = (str: string) => (str.length > MAX_LOG_CHAR ? `${str.substring(0, MAX_LOG_CHAR)}... (truncated)` : str);

    const log: MessageRowInsert = {
        ...body.log,
        message: truncate(body.log.message),
        accountId: account.id
    };
    const logCtx = logContextGetter.getStateLess({ id: String(body.activityLogId), accountId: account.id }, { logToConsole: false });
    void logCtx.log(log);
    res.status(204).send();

    return;
};

export const route: Route<PostLog> = { method: 'POST', path: '/environment/:environmentId/log' };

export const routeHandler: RouteHandler<PostLog, AuthLocals> = {
    ...route,
    validate,
    handler
};

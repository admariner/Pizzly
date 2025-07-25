import * as z from 'zod';

import db from '@nangohq/database';
import { defaultOperationExpiration, endUserToMeta, logContextGetter } from '@nangohq/logs';
import { configService, connectionService, errorManager, getConnectionConfig, getProvider, linkConnection } from '@nangohq/shared';
import { metrics, requireEmptyBody, stringifyError, zodErrorToHTTP } from '@nangohq/utils';

import { connectionCredential, connectionIdSchema, providerConfigKeySchema } from '../../helpers/validation.js';
import { connectionCreated, connectionCreationFailed } from '../../hooks/hooks.js';
import { asyncWrapper } from '../../utils/asyncWrapper.js';
import { errorRestrictConnectionId, isIntegrationAllowed } from '../../utils/auth.js';
import { hmacCheck } from '../../utils/hmac.js';

import type { LogContext } from '@nangohq/logs';
import type { PostPublicUnauthenticatedAuthorization } from '@nangohq/types';

const queryStringValidation = z
    .object({
        connection_id: connectionIdSchema.optional(),
        params: z.record(z.string(), z.any()).optional()
    })
    .and(connectionCredential);

const paramValidation = z
    .object({
        providerConfigKey: providerConfigKeySchema
    })
    .strict();

export const postPublicUnauthenticated = asyncWrapper<PostPublicUnauthenticatedAuthorization>(async (req, res) => {
    const valBody = requireEmptyBody(req);
    if (valBody) {
        res.status(400).send({ error: { code: 'invalid_body', errors: zodErrorToHTTP(valBody.error) } });
        return;
    }

    const queryStringVal = queryStringValidation.safeParse(req.query);
    if (!queryStringVal.success) {
        res.status(400).send({ error: { code: 'invalid_query_params', errors: zodErrorToHTTP(queryStringVal.error) } });
        return;
    }

    const paramVal = paramValidation.safeParse(req.params);
    if (!paramVal.success) {
        res.status(400).send({ error: { code: 'invalid_uri_params', errors: zodErrorToHTTP(paramVal.error) } });
        return;
    }

    const { account, environment, connectSession } = res.locals;
    const queryString: PostPublicUnauthenticatedAuthorization['Querystring'] = queryStringVal.data;
    const { providerConfigKey }: PostPublicUnauthenticatedAuthorization['Params'] = paramVal.data;
    const connectionConfig = queryString.params ? getConnectionConfig(queryString.params) : {};
    let connectionId = queryString.connection_id || connectionService.generateConnectionId();
    const hmac = 'hmac' in queryString ? queryString.hmac : undefined;
    const isConnectSession = res.locals['authType'] === 'connectSession';

    if (isConnectSession && queryString.connection_id) {
        errorRestrictConnectionId(res);
        return;
    }

    let logCtx: LogContext | undefined;

    try {
        const logCtx =
            isConnectSession && connectSession.operationId
                ? logContextGetter.get({ id: connectSession.operationId, accountId: account.id })
                : await logContextGetter.create(
                      {
                          operation: { type: 'auth', action: 'create_connection' },
                          meta: { authType: 'unauth', connectSession: endUserToMeta(res.locals.endUser) },
                          expiresAt: defaultOperationExpiration.auth()
                      },
                      { account, environment }
                  );

        if (!isConnectSession) {
            const checked = await hmacCheck({ environment, logCtx, providerConfigKey, connectionId, hmac, res });
            if (!checked) {
                return;
            }
        }

        const config = await configService.getProviderConfig(providerConfigKey, environment.id);
        if (!config) {
            void logCtx.error('Unknown provider config');
            await logCtx.failed();
            res.status(404).send({ error: { code: 'unknown_provider_config' } });
            return;
        }

        const provider = getProvider(config.provider);
        if (!provider) {
            void logCtx.error('Unknown provider');
            await logCtx.failed();
            res.status(404).send({ error: { code: 'unknown_provider_template' } });
            return;
        }

        if (provider.auth_mode !== 'NONE') {
            void logCtx.error('Provider does not support Unauthenticated', { provider: config.provider });
            await logCtx.failed();
            res.status(400).send({ error: { code: 'invalid_auth_mode' } });
            return;
        }

        if (!(await isIntegrationAllowed({ config, res, logCtx }))) {
            return;
        }

        // Reconnect mechanism
        if (isConnectSession && connectSession.connectionId) {
            const connection = await connectionService.getConnectionById(connectSession.connectionId);
            if (!connection) {
                void logCtx.error('Invalid connection');
                await logCtx.failed();
                res.status(400).send({ error: { code: 'invalid_connection' } });
                return;
            }
            connectionId = connection?.connection_id;
        }

        await logCtx.enrichOperation({ integrationId: config.id!, integrationName: config.unique_key, providerName: config.provider });

        const [updatedConnection] = await connectionService.upsertUnauthConnection({
            connectionId,
            providerConfigKey,
            connectionConfig,
            environment
        });

        if (!updatedConnection) {
            res.status(500).send({ error: { code: 'server_error', message: 'failed to create connection' } });
            void logCtx.error('Failed to create connection');
            await logCtx.failed();
            return;
        }

        if (isConnectSession) {
            await linkConnection(db.knex, { endUserId: connectSession.endUserId, connection: updatedConnection.connection });
        }

        await logCtx.enrichOperation({ connectionId: updatedConnection.connection.id, connectionName: updatedConnection.connection.connection_id });
        void logCtx.info('Unauthenticated connection creation was successful');
        await logCtx.success();

        void connectionCreated(
            {
                connection: updatedConnection.connection,
                environment,
                account,
                auth_mode: 'NONE',
                operation: updatedConnection.operation,
                endUser: isConnectSession ? res.locals['endUser'] : undefined
            },
            account,
            config,
            logContextGetter,
            undefined
        );

        metrics.increment(metrics.Types.AUTH_SUCCESS, 1, { auth_mode: provider.auth_mode });

        res.status(200).send({ connectionId, providerConfigKey });
    } catch (err) {
        const prettyError = stringifyError(err, { pretty: true });

        void connectionCreationFailed(
            {
                connection: { connection_id: connectionId, provider_config_key: providerConfigKey },
                environment,
                account,
                auth_mode: 'NONE',
                error: { type: 'unknown', description: `Error during Unauth create: ${prettyError}` },
                operation: 'unknown'
            },
            account
        );
        if (logCtx) {
            void logCtx.error('Error during Unauthenticated connection creation', { error: err });
            await logCtx.failed();
        }

        metrics.increment(metrics.Types.AUTH_FAILURE, 1, { auth_mode: 'NONE' });

        errorManager.handleGenericError(err, req, res);
    }
});

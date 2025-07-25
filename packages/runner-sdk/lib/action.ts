import { getProvider } from '@nangohq/providers';

import { AbortedSDKError, ActionError, UnknownProviderSDKError } from './errors.js';
import paginateService from './paginate.service.js';

import type { ZodMetadata } from './types.js';
import type { Nango } from '@nangohq/node';
import type {
    ApiKeyCredentials,
    ApiPublicConnectionFull,
    AppCredentials,
    AppStoreCredentials,
    BasicApiCredentials,
    BillCredentials,
    CustomCredentials,
    EnvironmentVariable,
    GetPublicConnection,
    GetPublicIntegration,
    HTTP_METHOD,
    JwtCredentials,
    MaybePromise,
    NangoProps,
    OAuth1Token,
    OAuth2ClientCredentials,
    Pagination,
    PostPublicTrigger,
    SetMetadata,
    SignatureCredentials,
    TbaCredentials,
    TwoStepCredentials,
    UnauthCredentials,
    UpdateMetadata,
    UserLogParameters,
    UserProvidedProxyConfiguration
} from '@nangohq/types';
import type { AxiosResponse } from 'axios';
import type * as z from 'zod';

const MEMOIZED_CONNECTION_TTL = 60000;
const MEMOIZED_INTEGRATION_TTL = 10 * 60 * 1000;

export type ProxyConfiguration = Omit<UserProvidedProxyConfiguration, 'files' | 'providerConfigKey' | 'connectionId'> & {
    providerConfigKey?: string;
    connectionId?: string;
};

export abstract class NangoActionBase<
    TMetadata extends ZodMetadata = never,
    TMetadataInferred = TMetadata extends never ? never : z.infer<Exclude<TMetadata, undefined>>
> {
    abstract nango: Nango;
    private attributes = {};
    activityLogId: string;
    syncId?: string;
    nangoConnectionId?: number;
    environmentId: number;
    environmentName?: string;
    syncJobId?: number;
    abortSignal?: NangoProps['abortSignal'];
    syncConfig?: NangoProps['syncConfig'];
    runnerFlags: NangoProps['runnerFlags'];
    scriptType: NangoProps['scriptType'];

    public connectionId: string;
    public providerConfigKey: string;
    public provider?: string;

    public ActionError = ActionError;

    protected memoizedConnections = new Map<string, { connection: ApiPublicConnectionFull; timestamp: number }>();
    protected memoizedIntegration = new Map<string, { integration: GetPublicIntegration['Success']['data']; timestamp: number }>();

    constructor(config: NangoProps) {
        this.connectionId = config.connectionId;
        this.environmentId = config.environmentId;
        this.providerConfigKey = config.providerConfigKey;
        this.runnerFlags = config.runnerFlags;
        this.activityLogId = config.activityLogId;
        this.scriptType = config.scriptType;

        if (config.syncId) {
            this.syncId = config.syncId;
        }

        if (config.nangoConnectionId) {
            this.nangoConnectionId = config.nangoConnectionId;
        }

        if (config.syncJobId) {
            this.syncJobId = config.syncJobId;
        }

        if (config.environmentName) {
            this.environmentName = config.environmentName;
        }

        if (config.provider) {
            this.provider = config.provider;
        }

        if (config.attributes) {
            this.attributes = config.attributes;
        }

        if (config.abortSignal) {
            this.abortSignal = config.abortSignal;
        }

        if (config.syncConfig) {
            this.syncConfig = config.syncConfig;
        }
    }

    protected getProxyConfig(config: ProxyConfiguration): UserProvidedProxyConfiguration {
        return {
            method: 'GET',
            ...config,
            providerConfigKey: config.providerConfigKey || this.providerConfigKey,
            headers: {
                ...(config.headers || {}),
                'user-agent': this.nango.userAgent
            }
        };
    }

    protected throwIfAborted(): void {
        if (this.abortSignal?.aborted) {
            throw new AbortedSDKError();
        }
    }

    public abstract proxy<T = any>(config: ProxyConfiguration): Promise<AxiosResponse<T>>;

    public async get<T = any>(config: Omit<ProxyConfiguration, 'method'>): Promise<AxiosResponse<T>> {
        return this.proxy({
            ...config,
            method: 'GET'
        });
    }

    public async post<T = any>(config: Omit<ProxyConfiguration, 'method'>): Promise<AxiosResponse<T>> {
        return this.proxy({
            ...config,
            method: 'POST'
        });
    }

    public async put<T = any>(config: Omit<ProxyConfiguration, 'method'>): Promise<AxiosResponse<T>> {
        return this.proxy({
            ...config,
            method: 'PUT'
        });
    }

    public async patch<T = any>(config: Omit<ProxyConfiguration, 'method'>): Promise<AxiosResponse<T>> {
        return this.proxy({
            ...config,
            method: 'PATCH'
        });
    }

    public async delete<T = any>(config: Omit<ProxyConfiguration, 'method'>): Promise<AxiosResponse<T>> {
        return this.proxy({
            ...config,
            method: 'DELETE'
        });
    }

    public async getToken(): Promise<
        | string
        | OAuth1Token
        | OAuth2ClientCredentials
        | BasicApiCredentials
        | ApiKeyCredentials
        | AppCredentials
        | AppStoreCredentials
        | UnauthCredentials
        | CustomCredentials
        | TbaCredentials
        | JwtCredentials
        | BillCredentials
        | TwoStepCredentials
        | SignatureCredentials
    > {
        this.throwIfAborted();
        return this.nango.getToken(this.providerConfigKey, this.connectionId);
    }

    /**
     * Get current integration
     */
    public async getIntegration(queries?: GetPublicIntegration['Querystring']): Promise<GetPublicIntegration['Success']['data']> {
        this.throwIfAborted();

        const key = queries?.include?.join(',') || 'default';
        const has = this.memoizedIntegration.get(key);
        if (has && MEMOIZED_INTEGRATION_TTL > Date.now() - has.timestamp) {
            return has.integration;
        }

        const { data: integration } = await this.nango.getIntegration({ uniqueKey: this.providerConfigKey }, queries);
        this.memoizedIntegration.set(key, { integration, timestamp: Date.now() });
        return integration;
    }

    public async getConnection(providerConfigKeyOverride?: string, connectionIdOverride?: string): Promise<GetPublicConnection['Success']> {
        this.throwIfAborted();

        const providerConfigKey = providerConfigKeyOverride || this.providerConfigKey;
        const connectionId = connectionIdOverride || this.connectionId;

        const credentialsPair = `${providerConfigKey}${connectionId}`;
        const cachedConnection = this.memoizedConnections.get(credentialsPair);

        if (!cachedConnection || Date.now() - cachedConnection.timestamp > MEMOIZED_CONNECTION_TTL) {
            const connection = await this.nango.getConnection(providerConfigKey, connectionId);
            this.memoizedConnections.set(credentialsPair, { connection, timestamp: Date.now() });
            return connection;
        }

        return cachedConnection.connection;
    }

    public async setMetadata(metadata: TMetadataInferred): Promise<AxiosResponse<SetMetadata['Success']>> {
        this.throwIfAborted();
        try {
            return await this.nango.setMetadata(this.providerConfigKey, this.connectionId, metadata as any);
        } finally {
            this.memoizedConnections.delete(`${this.providerConfigKey}${this.connectionId}`);
        }
    }

    public async updateMetadata(metadata: TMetadataInferred): Promise<AxiosResponse<UpdateMetadata['Success']>> {
        this.throwIfAborted();
        try {
            return await this.nango.updateMetadata(this.providerConfigKey, this.connectionId, metadata as any);
        } finally {
            this.memoizedConnections.delete(`${this.providerConfigKey}${this.connectionId}`);
        }
    }

    /**
     * @deprecated please use setMetadata instead.
     */
    public async setFieldMapping(fieldMapping: Record<string, string>): Promise<AxiosResponse<object>> {
        console.warn('setFieldMapping is deprecated. Please use setMetadata instead.');
        return await this.setMetadata(fieldMapping as any);
    }

    public async getMetadata<T = TMetadataInferred>(): Promise<T> {
        this.throwIfAborted();
        return (await this.getConnection(this.providerConfigKey, this.connectionId)).metadata as T;
    }

    public async getWebhookURL(): Promise<string | null | undefined> {
        this.throwIfAborted();
        const integration = await this.getIntegration({ include: ['webhook'] });
        return integration.webhook_url;
    }

    /**
     * @deprecated please use getMetadata instead.
     */
    public async getFieldMapping(): Promise<Record<string, string>> {
        console.warn('getFieldMapping is deprecated. Please use getMetadata instead.');
        const metadata = (await this.getMetadata()) as any;
        return (metadata['fieldMapping'] as Record<string, string>) || {};
    }

    /**
     * Log
     * @desc Log a message to the activity log which shows up in the Nango Dashboard
     * note that the last argument can be an object with a level property to specify the log level
     * @example
     * ```ts
     * await nango.log('This is a log message', { level: 'error' })
     * ```
     */
    public abstract log(message: any, options?: UserLogParameters | { [key: string]: any; level?: never }): MaybePromise<void>;
    public abstract log(message: string, ...args: [any, UserLogParameters]): MaybePromise<void>;
    public abstract log(...args: [...any]): MaybePromise<void>;

    public async getEnvironmentVariables(): Promise<EnvironmentVariable[] | null> {
        return await this.nango.getEnvironmentVariables();
    }

    public getFlowAttributes<A = object>(): A | null {
        if (!this.syncJobId) {
            throw new Error('There is no current sync to get attributes from');
        }

        return this.attributes as A;
    }

    public async *paginate<T = any>(config: ProxyConfiguration): AsyncGenerator<T[], undefined, void> {
        const provider = getProvider(this.provider as string);
        if (!provider) {
            throw new UnknownProviderSDKError({ provider: this.provider });
        }

        const templatePaginationConfig = provider.proxy?.paginate;

        if (!templatePaginationConfig && (!config.paginate || !config.paginate.type)) {
            throw Error('There was no pagination configuration for this integration or configuration passed in.');
        }

        const paginationConfig = {
            ...(templatePaginationConfig || {}),
            ...(config.paginate || {})
        } as Pagination;

        paginateService.validateConfiguration(paginationConfig);

        config.method = config.method || 'GET';

        const configMethod = config.method.toLocaleLowerCase();
        const passPaginationParamsInBody = config.paginate?.in_body ?? ['post', 'put', 'patch'].includes(configMethod);

        const updatedBodyOrParams: Record<string, any> = ((passPaginationParamsInBody ? config.data : config.params) as Record<string, any>) ?? {};
        const limitParameterName = paginationConfig.limit_name_in_request;

        if (paginationConfig['limit']) {
            updatedBodyOrParams[limitParameterName] = paginationConfig['limit'];
        }

        const proxyConfig = this.getProxyConfig(config);
        switch (paginationConfig.type) {
            case 'cursor':
                return yield* paginateService.cursor<T>(proxyConfig, paginationConfig, updatedBodyOrParams, passPaginationParamsInBody, this.proxy.bind(this));
            case 'link':
                return yield* paginateService.link<T>(proxyConfig, paginationConfig, updatedBodyOrParams, passPaginationParamsInBody, this.proxy.bind(this));
            case 'offset':
                return yield* paginateService.offset<T>(proxyConfig, paginationConfig, updatedBodyOrParams, passPaginationParamsInBody, this.proxy.bind(this));
            default:
                throw Error(`'${paginationConfig['type']}' pagination is not supported.}`);
        }
    }

    public async triggerAction<In = unknown, Out = object>(providerConfigKey: string, connectionId: string, actionName: string, input?: In): Promise<Out> {
        return await this.nango.triggerAction(providerConfigKey, connectionId, actionName, input);
    }

    public async zodValidateInput<T = any, Z = any>({ zodSchema, input }: { zodSchema: z.ZodType<Z>; input: T }): Promise<z.ZodSafeParseSuccess<Z>> {
        const parsedInput = zodSchema.safeParse(input);
        if (!parsedInput.success) {
            for (const error of parsedInput.error.issues) {
                await this.log(`Invalid input provided: ${error.message} at path ${error.path.join('.')}`, { level: 'error' });
            }
            throw new this.ActionError({
                message: 'Invalid input provided'
            });
        }

        return parsedInput;
    }

    public abstract triggerSync(
        providerConfigKey: string,
        connectionId: string,
        sync: string | { name: string; variant: string },
        syncMode?: PostPublicTrigger['Body']['sync_mode'] | boolean
    ): Promise<void | string>;

    public abstract startSync(providerConfigKey: string, syncs: (string | { name: string; variant: string })[], connectionId?: string): Promise<void>;

    /**
     * Uncontrolled fetch is a regular fetch without retry or credentials injection.
     * Only use that method when you want to access resources that are unrelated to the current connection/provider.
     */
    public async uncontrolledFetch(options: {
        url: URL;
        method?: HTTP_METHOD;
        headers?: Record<string, string> | undefined;
        body?: string | null;
    }): Promise<Response> {
        const props: RequestInit = {
            headers: new Headers(options.headers),
            method: options.method || 'GET'
            // TODO: use agent
        };

        if (options.body) {
            props.body = options.body;
        }

        return await fetch(options.url, props);
    }

    /**
     * Try to acquire a lock for a given key.
     * The lock is acquired if the key does not exist or if it exists but is expired.
     * The lock is valid for the entire execution of the script and will be released automatically when the script ends (or when releaseLock is called).
     */
    public abstract tryAcquireLock({ key, ttlMs }: { key: string; ttlMs: number }): Promise<boolean>;
    /**
     * Release the lock for a given key.
     */
    public abstract releaseLock({ key }: { key: string }): Promise<boolean>;
    /**
     * Release all locks acquired during the execution of a script.
     */
    public abstract releaseAllLocks(): Promise<void>;
}

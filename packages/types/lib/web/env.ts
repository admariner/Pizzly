export interface WindowEnv {
    apiUrl: string;
    publicUrl: string;
    connectUrl: string;
    gitHash: string | undefined;
    publicSentryKey: string;
    publicPosthogKey: string;
    publicPosthogHost: string;
    publicLogoDevKey: string;
    publicKoalaApiUrl: string;
    publicKoalaCdnUrl: string;
    publicStripeKey: string;
    isCloud: boolean;
    features: {
        logs: boolean;
        scripts: boolean;
        auth: boolean;
        managedAuth: boolean;
        gettingStarted: boolean;
        slack: boolean;
        plan: boolean;
    };
}

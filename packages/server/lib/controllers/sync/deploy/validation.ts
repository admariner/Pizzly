import * as z from 'zod';

import { frequencySchema, providerConfigKeySchema, syncNameSchema } from '../../../helpers/validation.js';

import type { NangoModelField, OnEventType } from '@nangohq/types';

const fileBody = z.object({ js: z.string(), ts: z.string() }).strict();
const jsonSchema = z
    .object({
        $schema: z.literal('http://json-schema.org/draft-07/schema#'),
        $comment: z.string(),
        definitions: z.record(z.string(), z.looseObject({}))
    })
    .strict();

const nangoModelFieldsBase = z.object({
    name: z.string(),
    dynamic: z.boolean().optional(),
    model: z.boolean().optional(),
    union: z.boolean().optional(),
    array: z.boolean().optional(),
    tsType: z.boolean().optional(),
    optional: z.boolean().optional()
});

const nangoModelFields: z.ZodType<NangoModelField> = nangoModelFieldsBase
    .extend({
        value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.lazy(() => nangoModelFields.array())])
    })
    .strict();

const nangoModel = z
    .object({
        name: z.string().max(255),
        fields: z.array(nangoModelFields),
        isAnon: z.boolean().optional()
    })
    .strict();

export const flowConfig = z
    .object({
        type: z.enum(['action', 'sync']),
        models: z.array(z.string().min(1).max(255)),
        runs: z.union([z.string().length(0), frequencySchema]).nullable(), // TODO: remove or after >0.58.5 is widely adopted
        auto_start: z.boolean().optional().default(false),
        attributes: z.object({}).optional(),
        metadata: z
            .object({
                scopes: z.array(z.string().max(255)).optional(),
                description: z.string().max(2000).optional()
            })
            .strict()
            .optional(),
        model_schema: z.union([z.string(), z.array(nangoModel)]).optional(),
        input: z.union([z.string().max(255), z.any()]).optional(),
        endpoints: z
            .array(
                z.union([
                    z
                        .object({
                            method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
                            path: z.string(),
                            group: z.string().min(1).max(64).optional()
                        })
                        .strict(),
                    z
                        .object({
                            GET: z.string().optional(),
                            POST: z.string().optional(),
                            PATCH: z.string().optional(),
                            PUT: z.string().optional(),
                            DELETE: z.string().optional()
                        })
                        .strict()
                ])
            )
            .optional(),
        syncName: syncNameSchema,
        providerConfigKey: providerConfigKeySchema,
        fileBody,
        version: z.string().optional(),
        track_deletes: z.boolean().optional().default(false),
        sync_type: z.enum(['incremental', 'full']).optional(),
        webhookSubscriptions: z.array(z.string().max(255)).optional()
    })
    .refine(
        (data) => {
            if (data.sync_type === 'incremental' && data.track_deletes) {
                return false;
            }
            return true;
        },
        { message: 'Track deletes is not supported for incremental syncs', path: ['track_deletes'] }
    )
    .strict();
const flowConfigs = z.array(flowConfig);
const onEventScriptsByProvider = z.array(
    z
        .object({
            providerConfigKey: providerConfigKeySchema,
            scripts: z.array(
                z
                    .object({
                        name: z.string().min(1).max(255),
                        fileBody,
                        event: z.enum(['post-connection-creation', 'pre-connection-deletion'])
                    })
                    .strict()
            )
        })
        .strict()
);
// DEPRECATED
const postConnectionScriptsByProvider = z.array(
    z
        .object({
            providerConfigKey: providerConfigKeySchema,
            scripts: z.array(z.object({ name: z.string().min(1).max(255), fileBody }).strict())
        })
        .strict()
        .transform((data) => ({
            providerConfigKey: data.providerConfigKey,
            scripts: data.scripts.map((script) => ({
                name: script.name,
                fileBody: script.fileBody,
                event: 'post-connection-creation' as OnEventType
            }))
        }))
);

const commonValidation = z
    .object({
        flowConfigs,
        onEventScriptsByProvider: onEventScriptsByProvider.optional(),
        // postConnectionScriptsByProvider is deprecated but still supported for backwards compatibility
        postConnectionScriptsByProvider: postConnectionScriptsByProvider.optional(),
        jsonSchema: jsonSchema.optional(),
        reconcile: z.boolean(),
        debug: z.boolean(),
        singleDeployMode: z.boolean().optional().default(false),
        sdkVersion: z
            .string()
            .regex(/[0-9]+\.[0-9]+\.[0-9]+-(zero|yaml)/)
            .optional()
    })
    .strict();

export const validation = commonValidation.transform((data) => {
    return {
        ...data
        // onEventScriptsByProvider: data.onEventScriptsByProvider || data.postConnectionScriptsByProvider
    };
});

export const validationWithNangoYaml = commonValidation
    .extend({
        nangoYamlBody: z.string()
    })
    .transform((data) => {
        return {
            ...data,
            onEventScriptsByProvider: data.onEventScriptsByProvider || data.postConnectionScriptsByProvider
        };
    });

import { z } from 'zod';
export declare const KNOWN_EVENT_TYPES: Set<string>;
export declare const EventEnvelopeSchema: z.ZodObject<{
    eventId: z.ZodString;
    type: z.ZodString;
    timestamp: z.ZodNumber;
    payload: z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>>;
}, z.core.$strip>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export declare function isKnownEventType(type: string): boolean;
export declare function createEnvelope(type: string, payload: Record<string, unknown>, eventId?: string): EventEnvelope;
//# sourceMappingURL=eventEnvelope.d.ts.map
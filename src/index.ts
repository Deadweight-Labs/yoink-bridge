export { verifyWebhook, signWebhook } from './signature.ts';
export type {
  VerifyWebhookOptions,
  VerifyResult,
  VerifyFailureReason,
  SignWebhookOptions,
  HeadersLike,
  RawBody,
} from './signature.ts';

export { createBridge, ignore, received, BridgeError } from './bridge.ts';
export type {
  Bridge,
  BridgeOptions,
  BridgeContext,
  DestinationConfig,
  EntryHandler,
  UndoHandler,
  UpdateHandler,
  SecretSource,
} from './bridge.ts';

export { MemoryKV } from './kv.ts';
export type { KVNamespaceLike } from './kv.ts';

export { generateSecret, secretProblem, buildSetupLink } from './link.ts';
export type { SetupLinkOptions } from './link.ts';

export {
  parseManifest,
  describeBridge,
  MANIFEST_LIMITS,
  DESTINATION_ID_PATTERN,
  GROUP_PATTERN,
  SETTING_NAME_PATTERN,
} from './manifest.ts';
export type { ParsedManifest, ParsedDestination, ParsedWaiting } from './manifest.ts';

export { MemoryDedupeStore } from './dedupe.ts';
export type { DedupeStore, DedupeRecord, StoredResponse, MemoryDedupeStoreOptions } from './dedupe.ts';

export { SDK_VERSION } from './version.ts';

export type {
  YoinkEvent,
  YoinkEventType,
  WebhookEnvelope,
  EntrySendEvent,
  EntryUndoEvent,
  EntryUpdateEvent,
  PingEvent,
  EntrySendData,
  EntryUndoData,
  EntryUpdateData,
  PreviousEntry,
  UpdateChange,
  KnownUpdateChange,
  PingData,
  Entry,
  EntryType,
  KnownEntryType,
  Due,
  DayPart,
  KnownDayPart,
  Attachment,
  AttachmentKind,
  KnownAttachmentKind,
  AppInfo,
  ConnectionInfo,
  DestinationRef,
  DestinationMode,
  Manifest,
  ManifestDestination,
  ManifestWaiting,
  Trigger,
  KnownTrigger,
  Fit,
  Receipt,
  Ignored,
} from './types.ts';

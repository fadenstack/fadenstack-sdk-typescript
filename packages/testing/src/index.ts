export {
  FakeGateway,
  lastToolResults,
  lastUserText,
  type CapturedRequest,
  type FakeAgent,
  type FakeGatewayOptions,
  type FakeModel,
  type FakeModelRequest,
  type FakePairing,
  type FakePairingOptions,
  type FakeProvenanceOptions,
  type FakeReply,
  type FakeSignedRecord,
  type FakeToolRule,
  type FakeUser,
} from "./fakeGateway.js";
export { toolContext, toolServices, type ToolContextOptions, type ToolServiceEntry } from "./tools.js";
export { DEFAULT_APPROVALS, FakeGrants, type FakeGrantReply, type FakeGrantRequest, type FakeGrantsOptions } from "./fakeGrants.js";

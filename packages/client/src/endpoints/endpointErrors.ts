import { FadenstackApiError, FadenstackError, FadenstackUnreachableError } from "../errors.js";

/** A status error's fields, without an undefined `code`. */
const fields = (type: string, code: string | undefined): { type: string; code?: string } => (code === undefined ? { type } : { type, code });

/** The endpoint refused the key (401, or 403 with a key): a wrong, expired or revoked key. */
export class EndpointKeyRejectedError extends FadenstackApiError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, fields("authentication_error", code));
  }
}

/** The endpoint refused the request's origin (403): a local server that admits only some origins (Ollama's `OLLAMA_ORIGINS`). */
export class EndpointOriginRefusedError extends FadenstackApiError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, fields("permission_error", code));
  }
}

/**
 * What answered is not an OpenAI-compatible chat endpoint at that address: no such route (404 without a model error), or an
 * answer in another shape. Usually a wrong base (it includes `/v1`).
 */
export class EndpointNotCompatibleError extends FadenstackApiError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, fields("not_compatible", code));
  }
}

/** The endpoint does not have the model asked for (Ollama: not pulled; a cloud: not deployed or not allowed). */
export class EndpointModelNotFoundError extends FadenstackApiError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, fields("model_not_found", code));
  }
}

/** The request was longer than the model's context: fewer turns, shorter instructions, or a model with a longer context. */
export class EndpointContextLengthError extends FadenstackApiError {
  constructor(status: number, message: string, code?: string) {
    super(status, message, fields("context_length_exceeded", code));
  }
}

/** Nothing answered at the endpoint's address (refused, not found, or no answer in time). */
export class EndpointUnreachableError extends FadenstackUnreachableError {}

/**
 * The server's certificate is not trusted (an unknown CA, a name that does not match, expired). Only where the platform says
 * so (Node gives the TLS error code); a browser cannot tell, so there the endpoint is just unreachable. A CA of one's own is
 * trusted through the platform's settings or the machine policy, never by a click.
 */
export class ServerCertificateError extends FadenstackError {}

/** Why a plain-http address is refused (D3; OWASP ASVS 5.0 V12). */
export type PlainHttpRefusal =
  /** The address is outside this device and outside a private network. */
  | "notLocal"
  /** A private-network address, without the person's opt-in for this endpoint. */
  | "noOptIn"
  /** A key would travel unencrypted. */
  | "keyOverPlainHttp"
  /** The machine policy forbids plain http in the local network (F09). */
  | "forbiddenByPolicy";

/** The SDK would not send this request over plain http (nothing was sent). */
export class EndpointPlainHttpRefusedError extends FadenstackError {
  readonly reason: PlainHttpRefusal;

  constructor(reason: PlainHttpRefusal, message: string) {
    super(message);
    this.reason = reason;
  }
}

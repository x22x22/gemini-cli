import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { GoogleAuth } from 'google-auth-library';
import type { MCPServerConfig } from '../config/config.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';

export class IAPProvider implements OAuthClientProvider {
  private readonly url: string;
  private readonly auth: GoogleAuth;

  // Properties required by OAuthClientProvider, with no-op values
  readonly redirectUrl = '';
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: 'Gemini CLI (IAP)',
    redirect_uris: [],
    grant_types: [],
    response_types: [],
    token_endpoint_auth_method: 'none',
  };
  private _clientInformation?: OAuthClientInformationFull;

  constructor(private readonly config: MCPServerConfig) {
    // Prioritize httpUrl but fall back to url for SSE transports.
    const targetUrl = this.config.httpUrl || this.config.url;

    if (!targetUrl) {
      throw new Error('A url or httpUrl must be provided for the IAP provider');
    }
    // Parse the full URL to safely extract the protocol and host.
    const urlObject = new URL(targetUrl);
    // Reconstruct the base URL, which will be used as the audience.
    this.url = `${urlObject.protocol}//${urlObject.host}`;
    this.auth = new GoogleAuth();
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this._clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationFull): void {
    this._clientInformation = clientInformation;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    // Note: We are placing the OIDC ID Token into the `access_token` field.
    // This is because the CLI's HTTP layer uses this field to construct the
    // `Authorization: Bearer <token>` header, which is the correct way to present
    // an ID token to IAP.
    const client = await this.auth.getIdTokenClient(this.url);
    const idToken = await client.idTokenProvider.fetchIdToken(this.url);

    if (!idToken) {
      console.error('Failed to get ID token from Google for IAP');
      return undefined;
    }

    const tokens: OAuthTokens = {
      access_token: idToken,
      token_type: 'Bearer',
    };
    return tokens;
  }

  saveTokens(_tokens: OAuthTokens): void {
    // No-op, ADC manages tokens.
  }

  redirectToAuthorization(_authorizationUrl: URL): void {
    // No-op
  }

  saveCodeVerifier(_codeVerifier: string): void {
    // No-op
  }

  codeVerifier(): string {
    // No-op
    return '';
  }
}

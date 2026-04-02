// Google Meet Space Creator
// SDK: @google-apps/meet  (SpacesServiceClient)
// Auth: google-auth-library OAuth2Client — accepts a plain OAuth 2.0 access token
// Required scope: https://www.googleapis.com/auth/meetings.space.created
//
// Token sources (in priority order):
//   1. access_token passed in the function call (per-request)
//   2. GOOGLE_MEET_ACCESS_TOKEN environment variable (server-wide)

import { SpacesServiceClient } from "@google-apps/meet";
import { OAuth2Client } from "google-auth-library";

/**
 * Create a Google Meet space using the official @google-apps/meet SDK.
 *
 * @param {Object} options
 * @param {string} [options.access_token]        - OAuth 2.0 user access token. Falls back to env var.
 * @param {string} [options.access_type]         - "OPEN" | "TRUSTED" | "RESTRICTED". Default: "OPEN"
 * @param {string} [options.entry_point_access]  - "ALL" | "CREATOR_APP_ONLY". Default: "ALL"
 *
 * @returns {Promise<{
 *   success: boolean,
 *   platform: "google_meet",
 *   meeting_url: string,
 *   meeting_code: string,
 *   space_name: string,
 *   config: object,
 *   error?: string
 * }>}
 */
export async function createGoogleMeetSpace(options = {}) {
  const {
    access_token,
    access_type        = "OPEN",
    entry_point_access = "ALL",
  } = options;

  // Resolve token — caller-provided first, then env var
  const token = access_token || process.env.GOOGLE_MEET_ACCESS_TOKEN;

  if (!token) {
    return {
      success: false,
      error: "Google Meet access token is required. "
           + "Pass access_token in the request body or set GOOGLE_MEET_ACCESS_TOKEN in environment variables.",
    };
  }

  try {
    console.log("[GoogleMeet] Creating space...");

    // Build an OAuth2Client from the raw access token —
    // SpacesServiceClient accepts any google-auth-library auth client.
    const auth = new OAuth2Client();
    auth.setCredentials({ access_token: token });

    const client = new SpacesServiceClient({ auth });

    // createSpace returns [space, request, response]
    const [space] = await client.createSpace({
      space: {
        config: {
          accessType:       access_type,
          entryPointAccess: entry_point_access,
        },
      },
    });

    if (!space?.meetingUri) {
      return {
        success: false,
        error:   "Google Meet SDK returned no meetingUri",
        raw:     space,
      };
    }

    console.log(`[GoogleMeet] ✓ Space created: ${space.meetingUri}`);

    return {
      success:      true,
      platform:     "google_meet",
      meeting_url:  space.meetingUri,
      meeting_code: space.meetingCode,
      space_name:   space.name,
      config:       space.config,
    };

  } catch (err) {
    // Google SDK wraps API errors — extract the cleanest message
    const message = err?.details || err?.message || String(err);
    console.error("[GoogleMeet] SDK error:", message);
    return { success: false, error: `Google Meet SDK error: ${message}` };
  }
}

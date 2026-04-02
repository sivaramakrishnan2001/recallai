// Google Meet Space Creator
// API: POST https://meet.googleapis.com/v2/spaces
// Auth: OAuth 2.0 Bearer token
// Required scope: https://www.googleapis.com/auth/meetings.space.created
//
// Token sources (in priority order):
//   1. access_token passed in the function call (per-request)
//   2. GOOGLE_MEET_ACCESS_TOKEN environment variable (server-wide)

const GOOGLE_MEET_API = "https://meet.googleapis.com/v2/spaces";

/**
 * Create a Google Meet space (a permanent or one-time meeting room).
 *
 * @param {Object} options
 * @param {string} [options.access_token]       - OAuth 2.0 access token. Falls back to env var.
 * @param {string} [options.access_type]        - "OPEN" | "TRUSTED" | "RESTRICTED". Default: "OPEN"
 * @param {string} [options.entry_point_access] - "ALL" | "CREATOR_APP_ONLY". Default: "ALL"
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
    access_type       = "OPEN",
    entry_point_access = "ALL",
  } = options;

  // Resolve token: caller-provided first, then env var
  const token = access_token || process.env.GOOGLE_MEET_ACCESS_TOKEN;

  if (!token) {
    return {
      success: false,
      error: "Google Meet access token is required. Pass access_token in the request body or set GOOGLE_MEET_ACCESS_TOKEN in environment variables.",
    };
  }

  const payload = {
    config: {
      accessType:        access_type,
      entryPointAccess:  entry_point_access,
    },
  };

  try {
    console.log("[GoogleMeet] Creating meeting space...");

    const response = await fetch(GOOGLE_MEET_API, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type":  "application/json",
        "Accept":        "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data?.error?.message || data?.error || `HTTP ${response.status}`;
      console.error("[GoogleMeet] API error:", errMsg);
      return {
        success: false,
        error:   `Google Meet API error (${response.status}): ${errMsg}`,
        details: data?.error,
      };
    }

    if (!data.meetingUri) {
      return {
        success: false,
        error:   "Google Meet API returned no meetingUri in response",
        raw:     data,
      };
    }

    console.log(`[GoogleMeet] ✓ Space created: ${data.meetingUri}`);

    return {
      success:      true,
      platform:     "google_meet",
      meeting_url:  data.meetingUri,
      meeting_code: data.meetingCode,
      space_name:   data.name,
      config:       data.config,
    };

  } catch (err) {
    console.error("[GoogleMeet] Fetch error:", err.message);
    return { success: false, error: err.message };
  }
}

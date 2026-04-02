// Microsoft Teams Online Meeting Creator
// API: POST https://graph.microsoft.com/v1.0/me/onlineMeetings
// Auth: Bearer token (Azure AD / Microsoft Entra ID)
// Required scope: OnlineMeetings.ReadWrite
//
// Token sources (in priority order):
//   1. access_token passed in the function call (per-request)
//   2. TEAMS_ACCESS_TOKEN environment variable (server-wide)

const TEAMS_API = "https://graph.microsoft.com/v1.0/me/onlineMeetings";

/**
 * Create a Microsoft Teams online meeting.
 *
 * @param {Object} options
 * @param {string} [options.access_token]   - Azure AD Bearer token. Falls back to env var.
 * @param {string} [options.subject]        - Meeting title. Default: "Interview Meeting"
 * @param {string} [options.start_datetime] - ISO 8601 UTC start time. Default: now + 5 min
 * @param {string} [options.end_datetime]   - ISO 8601 UTC end time. Default: now + 65 min
 * @param {string} [options.lobby_bypass]   - Who bypasses the lobby.
 *                                            "everyone" | "organizer" | "invited" | "organizationAndFederated"
 *                                            Default: "everyone"
 * @param {boolean} [options.dial_in_bypass] - Allow dial-in users to bypass lobby. Default: true
 *
 * @returns {Promise<{
 *   success: boolean,
 *   platform: "teams",
 *   meeting_url: string,
 *   meeting_id: string,
 *   subject: string,
 *   start_datetime: string,
 *   end_datetime: string,
 *   join_web_url: string,
 *   error?: string
 * }>}
 */
export async function createTeamsMeeting(options = {}) {
  const {
    access_token,
    subject          = "Interview Meeting",
    lobby_bypass     = "everyone",
    dial_in_bypass   = true,
  } = options;

  // Resolve token: caller-provided first, then env var
  const token = access_token || process.env.TEAMS_ACCESS_TOKEN;

  if (!token) {
    return {
      success: false,
      error: "Teams access token is required. Pass access_token in the request body or set TEAMS_ACCESS_TOKEN in environment variables.",
    };
  }

  // Default start: 5 minutes from now. Default end: 65 minutes from now (1-hour meeting).
  const now           = Date.now();
  const start_datetime = options.start_datetime || new Date(now + 5 * 60 * 1000).toISOString();
  const end_datetime   = options.end_datetime   || new Date(now + 65 * 60 * 1000).toISOString();

  const payload = {
    subject,
    startDateTime: start_datetime,
    endDateTime:   end_datetime,
    lobbyBypassSettings: {
      scope:                lobby_bypass,
      isDialInBypassEnabled: dial_in_bypass,
    },
  };

  try {
    console.log(`[Teams] Creating meeting: "${subject}"...`);

    const response = await fetch(TEAMS_API, {
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
      const errMsg = data?.error?.message || data?.error?.code || `HTTP ${response.status}`;
      console.error("[Teams] API error:", errMsg);
      return {
        success: false,
        error:   `Teams API error (${response.status}): ${errMsg}`,
        details: data?.error,
      };
    }

    if (!data.joinWebUrl) {
      return {
        success: false,
        error:   "Teams API returned no joinWebUrl in response",
        raw:     data,
      };
    }

    console.log(`[Teams] ✓ Meeting created: ${data.joinWebUrl}`);

    return {
      success:        true,
      platform:       "teams",
      meeting_url:    data.joinWebUrl,
      join_web_url:   data.joinWebUrl,
      meeting_id:     data.id,
      subject:        data.subject,
      start_datetime: data.startDateTime,
      end_datetime:   data.endDateTime,
      lobby_bypass_settings: data.lobbyBypassSettings,
    };

  } catch (err) {
    console.error("[Teams] Fetch error:", err.message);
    return { success: false, error: err.message };
  }
}

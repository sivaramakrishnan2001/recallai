// Microsoft Teams Online Meeting Creator
// SDK: @microsoft/microsoft-graph-client  (Client)
// Auth: Azure AD / Microsoft Entra ID Bearer token
// Required scope: OnlineMeetings.ReadWrite
//
// Token sources (in priority order):
//   1. access_token passed in the function call (per-request)
//   2. TEAMS_ACCESS_TOKEN environment variable (server-wide)
//
// Node.js 18+ has native global fetch — no polyfill needed.

import { Client } from "@microsoft/microsoft-graph-client";

/**
 * Create a Microsoft Teams online meeting using the official Graph SDK.
 *
 * @param {Object} options
 * @param {string}  [options.access_token]    - Azure AD Bearer token. Falls back to env var.
 * @param {string}  [options.subject]         - Meeting title. Default: "Interview Meeting"
 * @param {string}  [options.start_datetime]  - ISO 8601 UTC start. Default: now + 5 min
 * @param {string}  [options.end_datetime]    - ISO 8601 UTC end.   Default: now + 65 min
 * @param {string}  [options.lobby_bypass]    - Lobby bypass scope.
 *                                              "everyone" | "organizer" | "invited" | "organizationAndFederated"
 *                                              Default: "everyone"
 * @param {boolean} [options.dial_in_bypass]  - Allow dial-in bypass. Default: true
 *
 * @returns {Promise<{
 *   success: boolean,
 *   platform: "teams",
 *   meeting_url: string,
 *   meeting_id: string,
 *   subject: string,
 *   start_datetime: string,
 *   end_datetime: string,
 *   lobby_bypass_settings: object,
 *   error?: string
 * }>}
 */
export async function createTeamsMeeting(options = {}) {
  const {
    access_token,
    subject        = "Interview Meeting",
    lobby_bypass   = "everyone",
    dial_in_bypass = true,
  } = options;

  // Resolve token — caller-provided first, then env var
  const token = access_token || process.env.TEAMS_ACCESS_TOKEN;

  if (!token) {
    return {
      success: false,
      error: "Teams access token is required. "
           + "Pass access_token in the request body or set TEAMS_ACCESS_TOKEN in environment variables.",
    };
  }

  // Default window: starts 5 min from now, ends 65 min from now (1-hour meeting)
  const now            = Date.now();
  const start_datetime = options.start_datetime || new Date(now + 5  * 60 * 1000).toISOString();
  const end_datetime   = options.end_datetime   || new Date(now + 65 * 60 * 1000).toISOString();

  try {
    console.log(`[Teams] Creating meeting: "${subject}"...`);

    // Initialise Graph client — authProvider callback supplies the token per-request
    const graphClient = Client.init({
      authProvider: (done) => {
        done(null, token);
      },
    });

    // POST /me/onlineMeetings via the Graph SDK
    const meeting = await graphClient.api("/me/onlineMeetings").post({
      subject,
      startDateTime: start_datetime,
      endDateTime:   end_datetime,
      lobbyBypassSettings: {
        scope:                 lobby_bypass,
        isDialInBypassEnabled: dial_in_bypass,
      },
    });

    if (!meeting?.joinWebUrl) {
      return {
        success: false,
        error:   "Teams Graph SDK returned no joinWebUrl",
        raw:     meeting,
      };
    }

    console.log(`[Teams] ✓ Meeting created: ${meeting.joinWebUrl}`);

    return {
      success:               true,
      platform:              "teams",
      meeting_url:           meeting.joinWebUrl,
      join_web_url:          meeting.joinWebUrl,
      meeting_id:            meeting.id,
      subject:               meeting.subject,
      start_datetime:        meeting.startDateTime,
      end_datetime:          meeting.endDateTime,
      lobby_bypass_settings: meeting.lobbyBypassSettings,
    };

  } catch (err) {
    // Graph SDK wraps API errors in GraphError — extract the cleanest message
    const message = err?.message || String(err);
    const code    = err?.code    || err?.statusCode || "";
    console.error(`[Teams] SDK error [${code}]:`, message);
    return { success: false, error: `Teams Graph SDK error: ${message}`, code };
  }
}

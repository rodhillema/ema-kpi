/* ============================================================
   Email Service — SendGrid wrapper for Champion auth flows
   Environment: SENDGRID_API_KEY, APP_URL, FROM_EMAIL
   ============================================================ */

const sgMail = require('@sendgrid/mail');

const apiKey = (process.env.SENDGRID_API_KEY || '').trim();
if (apiKey) {
  sgMail.setApiKey(apiKey);
  console.log('[EMAIL] SendGrid configured (key starts with: ' + apiKey.substring(0, 5) + '...)');
} else {
  console.log('[EMAIL] No SENDGRID_API_KEY — running in dev mode (console only)');
}

const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@everymothersadvocate.org';
const FROM_NAME = '\u0112MA Impact Hub';

function getAppUrl() {
  return (
    process.env.APP_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : 'http://localhost:3000')
  );
}

/**
 * Send invite email to a new Champion user.
 * @param {{ email: string, firstName: string, inviteToken: string }} champion
 */
async function sendInviteEmail(champion) {
  const appUrl = getAppUrl();
  const link = `${appUrl}/set-password?token=${champion.inviteToken}`;

  if (!apiKey) {
    console.log(`[DEV] Invite email for ${champion.email}`);
    console.log(`[DEV] Set-password link: ${link}`);
    return;
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fdf7f3;font-family:'Lato',Helvetica,Arial,sans-serif;color:#2C2C2C;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf7f3;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
        <!-- Header (matches hub red nav) -->
        <tr>
          <td style="background:#ec482f;padding:22px 32px;">
            <table cellpadding="0" cellspacing="0" style="width:100%;">
              <tr>
                <td style="vertical-align:middle;">
                  <img src="${appUrl}/email-logo.png" alt="\u0112MA" width="48" height="auto" style="display:block;border:0;outline:none;">
                </td>
                <td style="vertical-align:middle;text-align:right;">
                  <div style="font-family:'Oswald',Helvetica,Arial,sans-serif;font-size:13px;font-weight:400;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,0.95);">
                    Impact Hub
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Title bar -->
        <tr>
          <td style="background:#f9ece8;border-bottom:2px solid #ec482f;padding:14px 32px;">
            <div style="font-family:'Oswald',Helvetica,Arial,sans-serif;font-size:11px;font-weight:400;letter-spacing:1.5px;text-transform:uppercase;color:#5A5A5A;">You\u2019re Invited</div>
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#2C2C2C;margin-top:4px;">Welcome to \u0112MA Impact Hub</div>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="font-size:16px;line-height:1.55;margin:0 0 16px;">
              Hi ${champion.firstName},
            </p>
            <p style="font-size:16px;line-height:1.55;margin:0 0 18px;">
              You\u2019ve been invited to <strong>\u0112MA Impact Hub</strong> \u2014 the reporting dashboard where you can track your affiliate\u2019s program outcomes, view key performance indicators, and access real-time data from your team.
            </p>
            <table cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 24px;">
              <tr><td style="background:#fdf7f3;border:1px solid #E0E0E0;border-left:3px solid #ec482f;border-radius:6px;padding:12px 16px;">
                <div style="font-family:'Oswald',Helvetica,Arial,sans-serif;font-size:10px;font-weight:400;letter-spacing:1.2px;text-transform:uppercase;color:#5A5A5A;margin-bottom:4px;">Username</div>
                <div style="font-size:15px;color:#2C2C2C;font-weight:700;">${champion.username || 'See your administrator'}</div>
              </td></tr>
            </table>
            <p style="font-size:16px;line-height:1.55;margin:0 0 20px;">
              Click the button below to set your password and activate your account:
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr><td align="center" style="background:#ec482f;border-radius:6px;box-shadow:0 2px 6px rgba(236,72,47,0.25);">
                <a href="${link}" target="_blank"
                   style="display:inline-block;padding:14px 36px;font-family:'Oswald',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;">
                  Set Your Password
                </a>
              </td></tr>
            </table>
            <p style="font-size:13px;line-height:1.55;color:#5A5A5A;margin:0 0 8px;">
              This link expires in <strong>48 hours</strong>. If it has expired, ask your administrator to resend the invitation.
            </p>
            <p style="font-size:13px;line-height:1.55;color:#5A5A5A;margin:0;">
              If you didn\u2019t expect this email, you can safely ignore it.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#123939;padding:18px 32px;">
            <p style="font-family:'Oswald',Helvetica,Arial,sans-serif;font-size:11px;font-weight:300;letter-spacing:1.2px;text-transform:uppercase;color:rgba(255,255,255,0.85);margin:0;">
              Every Mother\u2019s Advocate
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await sgMail.send({
    to: champion.email,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'You\u2019re invited to \u0112MA Impact Hub',
    html,
  });
}

/**
 * Send password-reset email to an existing Champion user.
 * @param {{ email: string, firstName: string, resetToken: string }} champion
 */
async function sendResetEmail(champion) {
  const appUrl = getAppUrl();
  const link = `${appUrl}/reset-password?token=${champion.resetToken}`;

  if (!apiKey) {
    console.log(`[DEV] Reset email for ${champion.email}`);
    console.log(`[DEV] Reset-password link: ${link}`);
    return;
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#fdf7f3;font-family:'Lato',Helvetica,Arial,sans-serif;color:#2C2C2C;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#fdf7f3;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">
        <!-- Header (matches hub red nav) -->
        <tr>
          <td style="background:#ec482f;padding:22px 32px;">
            <table cellpadding="0" cellspacing="0" style="width:100%;">
              <tr>
                <td style="vertical-align:middle;">
                  <img src="${appUrl}/email-logo.png" alt="\u0112MA" width="48" height="auto" style="display:block;border:0;outline:none;">
                </td>
                <td style="vertical-align:middle;text-align:right;">
                  <div style="font-family:'Oswald',Helvetica,Arial,sans-serif;font-size:13px;font-weight:400;letter-spacing:1.5px;text-transform:uppercase;color:rgba(255,255,255,0.95);">
                    Impact Hub
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <!-- Title bar -->
        <tr>
          <td style="background:#f9ece8;border-bottom:2px solid #ec482f;padding:14px 32px;">
            <div style="font-family:'Oswald',Helvetica,Arial,sans-serif;font-size:11px;font-weight:400;letter-spacing:1.5px;text-transform:uppercase;color:#5A5A5A;">Password Reset</div>
            <div style="font-family:Georgia,'Times New Roman',serif;font-size:24px;color:#2C2C2C;margin-top:4px;">Reset Your Password</div>
          </td>
        </tr>
        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <p style="font-size:16px;line-height:1.55;margin:0 0 16px;">
              Hi ${champion.firstName},
            </p>
            <p style="font-size:16px;line-height:1.55;margin:0 0 20px;">
              We received a request to reset your <strong>\u0112MA Impact Hub</strong> password. Click the button below to choose a new password:
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr><td align="center" style="background:#ec482f;border-radius:6px;box-shadow:0 2px 6px rgba(236,72,47,0.25);">
                <a href="${link}" target="_blank"
                   style="display:inline-block;padding:14px 36px;font-family:'Oswald',Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:#ffffff;text-decoration:none;">
                  Reset Password
                </a>
              </td></tr>
            </table>
            <p style="font-size:13px;line-height:1.55;color:#5A5A5A;margin:0 0 8px;">
              This link expires in <strong>1 hour</strong>. If it has expired, you can request a new one from the login page.
            </p>
            <p style="font-size:13px;line-height:1.55;color:#5A5A5A;margin:0;">
              If you didn\u2019t request this reset, you can safely ignore this email \u2014 your password won\u2019t change.
            </p>
          </td>
        </tr>
        <!-- Footer -->
        <tr>
          <td style="background:#123939;padding:18px 32px;">
            <p style="font-family:'Oswald',Helvetica,Arial,sans-serif;font-size:11px;font-weight:300;letter-spacing:1.2px;text-transform:uppercase;color:rgba(255,255,255,0.85);margin:0;">
              Every Mother\u2019s Advocate
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await sgMail.send({
    to: champion.email,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Reset your \u0112MA Impact Hub password',
    html,
  });
}

module.exports = { sendInviteEmail, sendResetEmail, getAppUrl };

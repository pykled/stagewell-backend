/**
 * Static legal / contact pages.
 *
 * The app and App Store listing link to https://stagewell.com/privacy and
 * /contact, which 404 (no site exists). Until a marketing site is live these
 * are served from the backend so the App Store review has a working privacy
 * policy (Guideline 5.1.1).
 *
 * DRAFT COPY — review before relying on it legally.
 */
import { Hono } from "hono";

const SUPPORT_EMAIL = "support@stagewell.com";
const COMPANY = "PYKLE LLC";
const UPDATED = "September 14, 2026";

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Stagewell</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #111827; background: #fff; line-height: 1.6; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 20px 80px; }
  h1 { font-size: 28px; margin: 0 0 4px; color: #0F2A44; }
  h2 { font-size: 18px; margin: 32px 0 8px; color: #0F2A44; }
  p, li { font-size: 16px; }
  .meta { color: #6B7280; font-size: 14px; margin-bottom: 24px; }
  a { color: #1E3A5F; }
  footer { margin-top: 48px; color: #6B7280; font-size: 13px; }
</style>
</head>
<body>
<main>
${body}
<footer>© ${new Date().getFullYear()} ${COMPANY} · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/contact">Contact</a></footer>
</main>
</body>
</html>`;
}

const privacy = page(
  "Privacy Policy",
  `<h1>Privacy Policy</h1>
<p class="meta">Stagewell for iOS · Last updated ${UPDATED}</p>

<p>Stagewell ("we", "us") is operated by ${COMPANY}. This policy explains what we collect when you use the Stagewell app and how we use it.</p>

<h2>What we collect</h2>
<ul>
  <li><strong>Account information.</strong> Your email address and a password hash, or your Apple ID token if you use Sign in with Apple. Stored with our authentication provider (Supabase).</li>
  <li><strong>Photos you choose to stage.</strong> When you tap "Stage", the photo you selected is sent to our servers and to Google's Gemini API to generate the staged image. We do not access your photo library beyond the photos you pick.</li>
  <li><strong>Staged images and originals.</strong> If you are signed in, staged images and their originals are stored in our cloud storage so they can be restored on another device. Free accounts are retained for 90 days; paid accounts for as long as the subscription is active.</li>
  <li><strong>Purchase information.</strong> Subscription status is processed by Apple and RevenueCat. We never see your payment card.</li>
  <li><strong>Usage and diagnostics.</strong> Credit usage, generation success/failure and basic device information needed to operate the service and to investigate problems.</li>
  <li><strong>Marketing preference.</strong> Whether you opted in to product emails. You can change this at any time from the Account tab.</li>
</ul>

<h2>How we use it</h2>
<ul>
  <li>To generate staged images and deliver them back to you.</li>
  <li>To manage your credits and subscription.</li>
  <li>To sync your listings across your devices.</li>
  <li>To answer support requests and fix bugs.</li>
  <li>To send product emails only if you opted in.</li>
</ul>

<h2>Who we share it with</h2>
<ul>
  <li><strong>Google (Gemini API)</strong> — receives the photo you stage in order to generate the result. Google does not use API data to train its models under its API terms.</li>
  <li><strong>Supabase</strong> — authentication, database and image storage.</li>
  <li><strong>Railway</strong> — hosts our backend.</li>
  <li><strong>Apple and RevenueCat</strong> — in-app purchases and subscription status.</li>
</ul>
<p>We do not sell your data and we do not share your photos with anyone else.</p>

<h2>Your choices</h2>
<ul>
  <li><strong>Delete your account</strong> from Account → Delete Account. This removes your account, your stored images and your credit history from our systems.</li>
  <li><strong>Delete a listing or image</strong> in the app to remove it from your device and from cloud storage.</li>
  <li><strong>Email us</strong> at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a> to request a copy of your data or ask questions.</li>
</ul>

<h2>Children</h2>
<p>Stagewell is intended for real estate professionals and is not directed at children under 13.</p>

<h2>Changes</h2>
<p>We will update this page when the policy changes and update the date at the top.</p>`,
);

const terms = page(
  "Terms of Service",
  `<h1>Terms of Service</h1>
<p class="meta">Stagewell for iOS · Last updated ${UPDATED}</p>
<p>By using Stagewell you agree to these terms.</p>
<h2>The service</h2>
<p>Stagewell generates virtually staged versions of room photos using AI. Results are computer-generated renderings. You are responsible for disclosing virtual staging to buyers and for complying with your MLS, brokerage and local advertising rules.</p>
<h2>Credits and subscriptions</h2>
<p>Staging consumes credits. Subscriptions renew through the App Store until cancelled in your Apple ID settings. Credits granted by a subscription are available for the period described on the plan. A credit is returned automatically if a staging fails.</p>
<h2>Your content</h2>
<p>You keep ownership of the photos you upload and the staged images we produce for you. You grant us the rights needed to process and store them to provide the service. Do not upload photos you do not have the right to use.</p>
<h2>Acceptable use</h2>
<p>Do not use Stagewell to misrepresent a property's structure, condition or fixtures, or to produce content that is unlawful or infringes someone's rights.</p>
<h2>Disclaimer</h2>
<p>The service is provided "as is". To the extent permitted by law, ${COMPANY} is not liable for indirect or consequential damages arising from use of the service.</p>
<h2>Contact</h2>
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>`,
);

const contact = page(
  "Contact",
  `<h1>Contact Stagewell</h1>
<p class="meta">We usually reply within one business day.</p>
<p>Support and billing questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
<p>When writing about a problem with a staging, include the approximate time, the room type and style you picked, and whether you were on Wi-Fi or cellular. That lets us find the request in our logs quickly.</p>`,
);

export const pagesRouter = new Hono();

pagesRouter.get("/privacy", (c) => c.html(privacy));
pagesRouter.get("/terms", (c) => c.html(terms));
pagesRouter.get("/contact", (c) => c.html(contact));

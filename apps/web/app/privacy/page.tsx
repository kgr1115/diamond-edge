import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * DRAFT — ATTORNEY REVIEW REQUIRED before commercial use.
 * This is personal-use boilerplate. Do not treat as legal advice.
 * Last updated: 2026-04-22
 */

export const metadata: Metadata = {
  title: 'Privacy Policy — Diamond Edge',
  description: 'Privacy Policy for Diamond Edge MLB picks information service.',
};

const EFFECTIVE_DATE = 'April 22, 2026';

export default function PrivacyPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      {/* Attorney-review banner */}
      <div className="mb-8 bg-amber-950/40 border border-amber-900/60 rounded-lg p-4 text-xs text-amber-300 leading-relaxed">
        <strong className="block mb-1">Draft — Attorney Review Required</strong>
        This document is a draft and has not been reviewed by a licensed attorney. It must be
        reviewed by qualified legal counsel before commercial deployment, including for compliance
        with applicable state privacy laws (CCPA, VCDPA, etc.).
      </div>

      <header className="mb-10 space-y-2">
        <h1 className="text-3xl font-bold text-white">Privacy Policy</h1>
        <p className="text-sm text-gray-500">Effective date: {EFFECTIVE_DATE}</p>
      </header>

      <div className="prose prose-invert prose-sm max-w-none space-y-8 text-gray-300 leading-relaxed">

        <Section title="1. Who We Are">
          <p>
            Diamond Edge (&ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;us&rdquo;) operates the
            Diamond Edge MLB picks information service at{' '}
            <a href="https://diamond-edge.co" className="text-blue-400 hover:underline">
              diamond-edge.co
            </a>
            . We are not a sportsbook, licensed handicapper, or financial services provider. We
            provide statistical analysis and AI-generated rationale for informational purposes.
          </p>
        </Section>

        <Section title="2. Information We Collect">
          <p>We collect the following categories of information:</p>
          <ul className="list-disc pl-5 space-y-1 mt-2">
            <li>
              <strong className="text-white">Account data:</strong> Email address and password
              (stored via Supabase Auth; password is never stored in plaintext).
            </li>
            <li>
              <strong className="text-white">Age verification:</strong> Date of birth, entered
              during onboarding, to verify you are 21 or older. We store the date you verified,
              not your raw DOB, after verification is complete.
            </li>
            <li>
              <strong className="text-white">Geographic data:</strong> We determine your state from
              your IP address at access time to enforce state-level legal restrictions. We store
              your declared state (&ldquo;geo_state&rdquo;) in your profile.
            </li>
            <li>
              <strong className="text-white">Billing data:</strong> Subscription tier and Stripe
              customer ID. We do not store card numbers — all payment data is handled by Stripe.
            </li>
            <li>
              <strong className="text-white">Usage data:</strong> Bankroll entries, bet logs, and
              in-app activity you explicitly create. We do not sell this data.
            </li>
            <li>
              <strong className="text-white">Log data:</strong> Server logs including IP address,
              browser type, and pages accessed. Used for security and debugging only.
            </li>
          </ul>
        </Section>

        <Section title="3. How We Use Your Information">
          <p>We use collected information to:</p>
          <ul className="list-disc pl-5 space-y-1 mt-2">
            <li>Authenticate your account and enforce age and geographic restrictions.</li>
            <li>Deliver the pick content and features appropriate to your subscription tier.</li>
            <li>Process subscription payments and manage your billing relationship via Stripe.</li>
            <li>Send transactional emails (account confirmation, billing receipts). We do not send
              marketing email without explicit opt-in.</li>
            <li>Maintain security, detect abuse, and comply with legal obligations.</li>
          </ul>
        </Section>

        <Section title="4. Data Sharing">
          <p>We do not sell your personal data. We share data only as follows:</p>
          <ul className="list-disc pl-5 space-y-1 mt-2">
            <li>
              <strong className="text-white">Supabase:</strong> Database and authentication
              provider. Data is stored in Supabase-managed Postgres.{' '}
              <a
                href="https://supabase.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                Supabase Privacy Policy
              </a>
              .
            </li>
            <li>
              <strong className="text-white">Stripe:</strong> Payment processing. Diamond Edge
              passes your email to Stripe to create a billing customer record; Stripe handles all
              card data under their PCI-compliant infrastructure.{' '}
              <a
                href="https://stripe.com/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:underline"
              >
                Stripe Privacy Policy
              </a>
              .
            </li>
            <li>
              <strong className="text-white">Vercel:</strong> Hosting and infrastructure. Request
              logs are processed by Vercel&apos;s edge network.
            </li>
            <li>
              <strong className="text-white">Legal:</strong> We may disclose data if required by
              law, court order, or to protect the rights of Diamond Edge or others.
            </li>
          </ul>
          <p className="text-amber-400 text-xs mt-3">
            [Attorney review required: confirm adequate data processing agreements with all
            sub-processors for applicable state privacy laws.]
          </p>
        </Section>

        <Section title="5. Data Retention">
          <p>
            We retain account data for the duration of your account plus a period required to
            satisfy legal, billing, and security obligations. Bet log and bankroll data you create
            is retained until you delete it or close your account. You may request deletion of
            your account and associated data by contacting us at{' '}
            <a href="mailto:support@diamond-edge.co" className="text-blue-400 hover:underline">
              support@diamond-edge.co
            </a>.
          </p>
        </Section>

        <Section title="6. Your Rights">
          <p>Depending on your jurisdiction, you may have rights to:</p>
          <ul className="list-disc pl-5 space-y-1 mt-2">
            <li>Access the personal data we hold about you.</li>
            <li>Correct inaccurate data.</li>
            <li>Request deletion of your data (&ldquo;right to be forgotten&rdquo;).</li>
            <li>Opt out of any sale of personal data (we do not sell data).</li>
          </ul>
          <p className="mt-2">
            To exercise any of these rights, contact us at{' '}
            <a href="mailto:support@diamond-edge.co" className="text-blue-400 hover:underline">
              support@diamond-edge.co
            </a>. We will respond within 30 days.
          </p>
          <p className="text-amber-400 text-xs mt-3">
            [Attorney review required: confirm rights coverage for CCPA (CA), VCDPA (VA), CPA (CO),
            and other applicable state privacy laws in the ALLOW jurisdiction list.]
          </p>
        </Section>

        <Section title="7. Cookies and Tracking">
          <p>
            Diamond Edge uses cookies solely for authentication (session management via Supabase
            Auth). We do not use third-party tracking, advertising cookies, or behavioral
            profiling tools. No analytics platform with user-level tracking is active in v1.
          </p>
        </Section>

        <Section title="8. Responsible Gambling and Sensitive Data">
          <p>
            Age verification data (date of birth, verification timestamp) is treated as sensitive
            information. It is used only to enforce the 21+ requirement and is not shared with
            third parties for any other purpose. Geographic restriction data (geo_state) is used
            only to enforce legal jurisdiction requirements.
          </p>
        </Section>

        <Section title="9. Children">
          <p>
            The Service is not directed at anyone under 21 years of age. We do not knowingly
            collect data from minors. If you believe a minor has created an account, contact us
            immediately at{' '}
            <a href="mailto:support@diamond-edge.co" className="text-blue-400 hover:underline">
              support@diamond-edge.co
            </a>{' '}
            and we will delete the account.
          </p>
        </Section>

        <Section title="10. Security">
          <p>
            We implement reasonable technical and organizational measures to protect your data,
            including encrypted connections (HTTPS), Supabase Row-Level Security (RLS), and
            service-role key segregation. No method of transmission or storage is 100% secure;
            we cannot guarantee absolute security.
          </p>
        </Section>

        <Section title="11. Changes to This Policy">
          <p>
            We may update this Privacy Policy. Material changes will be communicated via the email
            address on your account or via an in-app notice at least 7 days before taking effect.
            Continued use after notice constitutes acceptance.
          </p>
        </Section>

        <Section title="12. Contact">
          <p>
            Questions about this Privacy Policy or your data? Contact us at{' '}
            <a href="mailto:support@diamond-edge.co" className="text-blue-400 hover:underline">
              support@diamond-edge.co
            </a>.
          </p>
        </Section>
      </div>

      {/* Responsible gambling footer — required on all surfaces per compliance spec */}
      <div className="mt-12 border-t border-gray-800 pt-6 text-xs text-gray-500 leading-relaxed">
        Diamond Edge is an information service. We do not place bets or hold funds on your behalf.{' '}
        <strong className="text-gray-400">21+ only.</strong> Available only where DraftKings and
        FanDuel legally operate. Problem gambling? Call{' '}
        <a href="tel:18005224700" className="underline hover:text-gray-300">1-800-522-4700</a> (24/7,
        free, confidential).{' '}
        <Link href="/terms" className="underline hover:text-gray-300">Terms of Service</Link>
        {' | '}
        <Link href="/responsible-gambling" className="underline hover:text-gray-300">Responsible Gambling</Link>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-white mb-3">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

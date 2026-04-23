import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * DRAFT — ATTORNEY REVIEW REQUIRED before commercial use.
 * This is personal-use boilerplate. Do not treat as legal advice.
 * Last updated: 2026-04-22
 */

export const metadata: Metadata = {
  title: 'Terms of Service — Diamond Edge',
  description: 'Terms of Service for Diamond Edge MLB picks information service.',
};

const EFFECTIVE_DATE = 'April 22, 2026';

export default function TermsPage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      {/* Attorney-review banner */}
      <div className="mb-8 bg-amber-950/40 border border-amber-900/60 rounded-lg p-4 text-xs text-amber-300 leading-relaxed">
        <strong className="block mb-1">Draft — Attorney Review Required</strong>
        This document is a draft and has not been reviewed by a licensed attorney. It must not be
        used in a commercial context until reviewed by qualified legal counsel familiar with sports
        betting information services and applicable state laws.
      </div>

      <header className="mb-10 space-y-2">
        <h1 className="text-3xl font-bold text-white">Terms of Service</h1>
        <p className="text-sm text-gray-500">Effective date: {EFFECTIVE_DATE}</p>
      </header>

      <div className="prose prose-invert prose-sm max-w-none space-y-8 text-gray-300 leading-relaxed">

        <Section title="1. Acceptance of Terms">
          <p>
            By accessing or using Diamond Edge (&ldquo;the Service&rdquo;), you agree to be bound
            by these Terms of Service. If you do not agree, do not use the Service. These Terms
            apply to all visitors, users, and others who access or use the Service.
          </p>
        </Section>

        <Section title="2. Eligibility — 21+ Only">
          <p>
            You must be at least <strong className="text-white">21 years of age</strong> to use the
            Service. By using the Service, you represent and warrant that you meet this age
            requirement. Diamond Edge reserves the right to terminate accounts where age cannot be
            verified.
          </p>
          <p>
            The Service is available only in jurisdictions where both DraftKings and FanDuel are
            fully licensed and legally operational for sports wagering. A geo-restriction is applied
            at access time. It is your responsibility to confirm that sports betting is legal in
            your jurisdiction before using any information provided by Diamond Edge.
          </p>
        </Section>

        <Section title="3. Nature of the Service — Information Only">
          <p>
            Diamond Edge is an <strong className="text-white">information and analysis service</strong>.
            We provide statistical analysis, AI-generated rationale, and historical performance data
            relating to Major League Baseball betting markets. We do not:
          </p>
          <ul className="list-disc pl-5 space-y-1 mt-2">
            <li>Place bets on your behalf.</li>
            <li>Hold, custody, or manage any funds.</li>
            <li>Act as a sportsbook, bookmaker, or licensed handicapper.</li>
            <li>Guarantee any specific outcome, profit, or return on any pick or subscription.</li>
          </ul>
          <p className="mt-3">
            All picks, probabilities, and expected-value figures are outputs of statistical models
            and are provided for informational purposes only. Past pick performance does not
            guarantee future results. Sports betting involves real financial risk and you may lose
            money.
          </p>
        </Section>

        <Section title="4. Personal Use Only">
          <p>
            The Service and its content — including picks, rationale, model outputs, and performance
            data — are licensed for your personal, non-commercial use only. You may not:
          </p>
          <ul className="list-disc pl-5 space-y-1 mt-2">
            <li>Redistribute, resell, or sublicense picks or content to any third party.</li>
            <li>Scrape, bulk-download, or systematically extract data from the Service.</li>
            <li>Use the Service to build a competing product or service without written permission.</li>
          </ul>
        </Section>

        <Section title="5. Subscription and Billing">
          <p>
            Paid subscriptions are billed monthly via Stripe. You may cancel at any time; access
            continues until the end of the current billing period. No refunds are issued for partial
            periods. Diamond Edge reserves the right to change pricing with reasonable notice.
          </p>
          <p className="mt-2">
            Subscriptions are personal and non-transferable. Sharing account credentials is a
            violation of these Terms.
          </p>
        </Section>

        <Section title="6. Responsible Gambling">
          <p>
            Diamond Edge takes problem gambling seriously. We require all users to be 21+ and to
            complete an age verification step before accessing pick content. The following
            responsible gambling copy applies to all use of the Service:
          </p>
          <blockquote className="border-l-2 border-amber-700 pl-4 text-amber-300 text-xs mt-3 leading-relaxed">
            Diamond Edge is an information and analysis service. We do not place bets or hold funds.
            Sports betting involves real financial risk. Past pick performance does not guarantee
            future results. If you or someone you know is struggling with problem gambling, free,
            confidential help is available 24/7 at{' '}
            <a href="tel:18005224700" className="underline">1-800-522-4700</a> or{' '}
            <a href="https://ncpgambling.org" target="_blank" rel="noopener noreferrer" className="underline">
              ncpgambling.org
            </a>.
          </blockquote>
          <p className="mt-3">
            If gambling is causing financial stress, relationship harm, or other negative impacts in
            your life, please seek help before or instead of subscribing.
          </p>
        </Section>

        <Section title="7. Disclaimers and Limitation of Liability">
          <p>
            THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS AVAILABLE&rdquo; WITHOUT
            WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO WARRANTIES OF
            MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR NON-INFRINGEMENT. DIAMOND EDGE
            DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED, ERROR-FREE, OR THAT ANY
            SPECIFIC PICK WILL RESULT IN A WINNING WAGER.
          </p>
          <p className="mt-3">
            TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, DIAMOND EDGE AND ITS OPERATORS
            SHALL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE
            DAMAGES, INCLUDING LOSS OF PROFITS, WAGERING LOSSES, OR DATA, ARISING OUT OF OR IN
            CONNECTION WITH YOUR USE OF THE SERVICE.
          </p>
        </Section>

        <Section title="8. Intellectual Property">
          <p>
            All content, including but not limited to statistical models, AI-generated rationale,
            UI design, and branding, is the property of Diamond Edge and its operators. Unauthorized
            use is prohibited.
          </p>
        </Section>

        <Section title="9. Termination">
          <p>
            Diamond Edge reserves the right to suspend or terminate your account at any time for
            violation of these Terms, fraudulent activity, or at our sole discretion. You may delete
            your account at any time via the account settings page.
          </p>
        </Section>

        <Section title="10. Changes to Terms">
          <p>
            We may update these Terms from time to time. Material changes will be communicated via
            the email address associated with your account or via an in-app notice. Continued use
            after changes constitutes acceptance.
          </p>
        </Section>

        <Section title="11. Governing Law">
          <p>
            These Terms shall be governed by and construed in accordance with the laws of the United
            States. Any disputes arising under these Terms are subject to binding arbitration on an
            individual basis; class actions are waived to the extent permitted by law.
          </p>
          <p className="mt-2 text-amber-400 text-xs">
            [Attorney review required: confirm governing law, jurisdiction, and arbitration clause
            for all active states in the ALLOW list.]
          </p>
        </Section>

        <Section title="12. Contact">
          <p>
            Questions about these Terms? Contact us at{' '}
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
        <Link href="/privacy" className="underline hover:text-gray-300">Privacy Policy</Link>
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

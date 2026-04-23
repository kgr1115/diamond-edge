import Link from 'next/link';

/**
 * Post-Stripe-checkout success page.
 * Stripe redirects here after a successful subscription purchase.
 * The webhook handles the DB update — this page is just a friendly confirmation.
 */
export default function BillingSuccessPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-6">
        <div className="text-5xl">✓</div>
        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-white">Subscription Activated!</h1>
          <p className="text-gray-400">
            Your Diamond Edge subscription is now active. It may take a moment for your account to
            reflect your new tier.
          </p>
        </div>
        <Link
          href="/picks/today"
          className="inline-block bg-blue-600 hover:bg-blue-500 text-white font-medium px-6 py-2.5 rounded-lg transition-colors"
        >
          View Today&apos;s Picks
        </Link>
      </div>
    </div>
  );
}

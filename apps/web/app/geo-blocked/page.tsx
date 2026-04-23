/**
 * Geo-block screen. Rendered when middleware redirects a user from an unsupported state.
 * Static Server Component — no interactivity required.
 */

const ALLOW_STATES = [
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DC', name: 'Washington DC' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MO', name: 'Missouri' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'OH', name: 'Ohio' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WY', name: 'Wyoming' },
];

export default function GeoBlockedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="max-w-lg w-full space-y-6">
        <div className="text-center space-y-3">
          <h1 className="text-2xl font-bold text-white">Not Available in Your Location</h1>
          <p className="text-gray-400 text-sm leading-relaxed">
            Diamond Edge is currently available only in states where DraftKings and FanDuel are both
            fully licensed and operational. Your location is not yet supported.
          </p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
            Available states ({ALLOW_STATES.length})
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {ALLOW_STATES.map((state) => (
              <div key={state.code} className="text-xs text-gray-300 py-0.5">
                <span className="font-mono text-gray-500 mr-1">{state.code}</span>
                {state.name}
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs text-gray-600 text-center">
          Problem gambling? Call{' '}
          <a href="tel:18005224700" className="underline">1-800-522-4700</a> (24/7, free).
        </p>
      </div>
    </div>
  );
}

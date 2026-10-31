# Address Autocomplete Contract

The member-details preview includes an optional address-suggestion control. It is disabled by default and does not contact a provider until a user enables it and a same-origin endpoint is configured.

## Browser contract

The browser requests:

`GET /api/address-suggestions?q=<URL-encoded-query>`

The endpoint must be same-origin and return:

```json
{
  "suggestions": [
    {
      "label": "10 Example Street, Sample City",
      "street": "10 Example Street",
      "city": "Sample City",
      "region": "Sample Region",
      "postal_code": "12345",
      "country_code": "US"
    }
  ]
}
```

The UI accepts at most six suggestions, uses text nodes rather than HTML injection, aborts stale requests, waits 300 ms after typing, and supports keyboard selection with arrow keys, Enter and Escape. A user must verify the completed fields. Manual entry remains available if the service is off or unavailable.

## Provider and privacy requirements

- The current preview has no address provider and no endpoint implementation. It must show the manual-entry fallback rather than inventing results.
- Do not call a third-party geocoding API directly from the browser.
- A future same-origin serverless endpoint must call an approved provider using a server-side secret, validate and normalize provider results, enforce rate limits and abuse controls, cap response size, and avoid logging full address queries.
- Select a provider only after privacy, data residency, licensing, commercial terms, retention, security and geographic coverage review.
- Do not persist address search text or selected results to local storage in this demo.
- Do not treat an autocomplete match as proof of residence, identity, or eligibility.
- The endpoint must return only the fields needed to complete the form and must never return provider secrets.

The Netlify CSP permits same-origin API requests only (`connect-src 'self'`). It does not authorize external browser requests.

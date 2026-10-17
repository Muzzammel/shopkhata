# Intermittent `/payments?_rsc=` 503 (post-RC6 investigation)

Status: **OPEN. Root cause not proven. No new evidence since the first sighting. No application code was changed for it.**

## 1. Observed facts

- During the RC6 gate, one prefetch request for `/payments?_rsc=…` returned 503.
- It did not recur on retry.
- The Hobby plan keeps about 30 minutes of runtime logs and that window had rolled over before anyone looked, so there is **no request ID, no `x-vercel-id` and no log line** for the failing request.
- The platform logs showed zero 5xx in the 30 minutes before the investigation.
- Vercel project: Fluid Compute on, Node 22, one function region (`bom1`), `autoExposeSystemEnvs` on, Hobby plan.
- One page view fans out about 27 uncached dynamic invocations (every nav link, three times). Each does a Supabase auth check in the proxy plus the layout's actor lookup.

## 2. Ruled out (by reading the code)

- No application code path returns 503 for `/payments` or any page. The only explicit 503 is `app/(app)/exports/[kind]/route.ts` ("The export could not be prepared"), which is not this URL.
- Failures inside a request map to other statuses: a proxy `getClaims` error redirects to `/login` (307); a `getCurrentActor` failure redirects to `/login`; a thrown `PAYMENT_LIST_UNAVAILABLE` or a Supabase error renders `app/(app)/error.tsx` (500).
- Therefore the 503 was produced **outside the application code** (the Vercel platform, or the network in front of it). This is an inference from the code, not from a captured response.

## 3. Local concurrency results (local production build, `next start`)

| Test | Result |
| --- | --- |
| Owner opens `/` and waits 4 s | 29 `_rsc` requests fired by the nav links' own prefetching, all 200 |
| `/payments?_rsc=` with `RSC: 1` and `Next-Router-Prefetch: 1`, 1 / 10 / 50 / 150 concurrent | 200 for every request (150 in 0.8 s) |
| All 9 nav destinations in parallel, 10 rounds (90 requests) | 200 for every request |

The app does not fail under bursty prefetch on its own, on a local server. This says nothing about Vercel's infrastructure.

## 4. Platform hypothesis — UNPROVEN

**UNPROVEN.** The prefetch burst (section 1) combined with a cold start or platform throttling on a Hobby project *could* produce a platform-generated 503. Nothing observed confirms or refutes this, and it must not be treated as the cause.

Also not checked (each is an open question, not a finding):

- Supabase region versus `bom1`: reading production project metadata was not permitted in this session, so cross-region latency is unmeasured.
- Refresh-token rotation under concurrent expired-token requests: would need a short local `jwt_expiry`. By code reading it ends in a 307, not a 503.

## 5. If it happens again: capture procedure

Do this **within 30 minutes** of the failure; after that the Hobby logs are gone.

1. Record the exact URL, the local time (with time zone), the signed-in role, and whether it was a navigation or a background prefetch (an `_rsc` request in the browser's Network tab).
2. From the failing response in the browser's Network tab, save the **response headers**, especially `x-vercel-id`, `x-vercel-cache`, `server` and `content-type`, and the response body. A Vercel-generated error page differs from an application page.
3. Note the deployment that served it: `curl -s https://shopkhata.vercel.app/api/health` returns the deployment's commit SHA as `release`.
4. Pull the platform's view while it is still available:
   `vercel logs --scope muzzammels-projects --since 30m --query 'status:5xx'`
   A platform-generated 503 shows **no function log line** for the request; a function-generated one shows our JSON log or a stack.
5. Add the findings to this file under a dated heading and update the status line above.

Only if a pattern emerges, consider `prefetch={false}` on the nav links (it cuts the burst to on-click requests). That is a behaviour change and was deliberately not made speculatively.

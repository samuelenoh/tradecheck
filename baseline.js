'use strict';
/*
 * Built-in baseline schedule of US releases that move markets. Dates and times are exactly as published.
 * It is the safety net: live feeds (see poller.js) override it, and it keeps the tool useful if a feed is down.
 *
 * Sources: BLS CPI schedule (bls.gov/schedule/news_release/cpi.htm), Federal Reserve FOMC calendar,
 * Reuters Fed events list (minutes), and the BLS and BEA calendars as mirrored by secondary sites (jobs, PCE).
 * Impact labels are our own classification. Checked 6 Oct 2026; covers through 10 Dec 2026.
 *
 * public/index.html carries an identical copy for use when no server is connected.
 * test/baseline.test.js fails if the two ever differ.
 */
module.exports = {
  asOf: '2026-10-06',
  events: [
    { n: 'FOMC minutes (September meeting)', cat: 'Fed', kind: 'fomc-minutes', t: '2026-10-07T14:00:00-04:00', imp: 'Medium' },
    { n: 'US CPI inflation (September data)', cat: 'Inflation', kind: 'cpi', t: '2026-10-14T08:30:00-04:00', imp: 'High' },
    { n: 'FOMC interest rate decision', cat: 'Fed', kind: 'fomc', t: '2026-10-28T14:00:00-04:00', imp: 'High' },
    { n: 'US PCE inflation (September data)', cat: 'Inflation', kind: 'pce', t: '2026-11-04T08:30:00-05:00', imp: 'Medium' },
    { n: 'US jobs report (October data)', cat: 'Jobs', kind: 'jobs', t: '2026-11-06T08:30:00-05:00', imp: 'High' },
    { n: 'US CPI inflation (October data)', cat: 'Inflation', kind: 'cpi', t: '2026-11-10T08:30:00-05:00', imp: 'High' },
    { n: 'FOMC minutes (October meeting)', cat: 'Fed', kind: 'fomc-minutes', t: '2026-11-18T14:00:00-05:00', imp: 'Medium' },
    { n: 'US PCE inflation (October data)', cat: 'Inflation', kind: 'pce', t: '2026-12-02T08:30:00-05:00', imp: 'Medium' },
    { n: 'US jobs report (November data)', cat: 'Jobs', kind: 'jobs', t: '2026-12-04T08:30:00-05:00', imp: 'High' },
    { n: 'FOMC rate decision and projections', cat: 'Fed', kind: 'fomc', t: '2026-12-09T14:00:00-05:00', imp: 'High' },
    { n: 'US CPI inflation (November data)', cat: 'Inflation', kind: 'cpi', t: '2026-12-10T08:30:00-05:00', imp: 'High' },
  ],
};

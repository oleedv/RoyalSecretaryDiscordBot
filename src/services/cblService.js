import logger from '../logger.js';

const log = logger.child({ module: 'cbl' });

export async function fetchCblData(steamId) {
  try {
    log.info({ steamId }, 'CBL: fetching data');
    const res = await fetch('https://communitybanlist.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        query: `query($id: String!) {
          steamUser(id: $id) {
            id
            riskRating
            reputationPoints
            bans(expired: false, first: 10) {
              edges {
                node {
                  id
                  reason
                  created
                  expires
                  banList {
                    name
                    organisation { name }
                  }
                }
              }
            }
            expiredBans: bans(expired: true, first: 100) {
              edges { node { id } }
            }
          }
        }`,
        variables: { id: steamId },
      }),
    });
    if (!res.ok) {
      log.warn({ steamId, status: res.status }, 'CBL: API returned non-OK status');
      return null;
    }
    const json = await res.json();
    return json?.data?.steamUser ?? null;
  } catch (err) {
    log.warn({ err, steamId }, 'CBL: fetch failed');
    return null;
  }
}

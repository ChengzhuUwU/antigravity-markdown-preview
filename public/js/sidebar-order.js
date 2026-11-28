/**
 * Freeze the left-sidebar project and session order for one page lifetime.
 * The first roster keeps activity order. Later updates do not reshuffle it.
 * A project that appears after that snapshot is inserted at the top.
 * A session that appears inside an existing project is appended.
 */

export function createSidebarOrder() {
  return {
    projects: [],
    sessions: new Map(),
  };
}

function activityRank(item) {
  const stamp = Number(item?.latestUpdatedAt ?? item?.updatedAt) || 0;
  return stamp;
}

function compareActivityThenKey(a, b) {
  const delta = activityRank(b) - activityRank(a);
  if (delta !== 0) return delta;
  return String(a.key || a.id || '').localeCompare(String(b.key || b.id || ''));
}

/**
 * Remember the full conversation roster. Call this with the unfiltered list
 * so a sidebar search cannot drop projects from the frozen order.
 */
export function noteSidebarRoster(groups, order, { unassignedKey = 'Unassigned' } = {}) {
  if (!groups || groups.length === 0) return order;
  const present = new Map(groups.map((group) => [group.key, group]));
  const known = new Set(order.projects);
  const newcomers = [];
  for (const group of groups || []) {
    if (!group?.key || group.key === unassignedKey || known.has(group.key)) continue;
    newcomers.push(group);
  }
  newcomers.sort(compareActivityThenKey);

  const kept = order.projects.filter((key) => present.has(key) && key !== unassignedKey);
  order.projects = [
    ...newcomers.map((group) => group.key),
    ...kept,
    ...(present.has(unassignedKey) ? [unassignedKey] : []),
  ];

  const liveKeys = new Set(order.projects);
  for (const key of [...order.sessions.keys()]) {
    if (!liveKeys.has(key)) order.sessions.delete(key);
  }

  for (const group of groups || []) {
    if (!group?.key) continue;
    const prev = order.sessions.get(group.key) || [];
    const prevSet = new Set(prev);
    const items = Array.isArray(group.items) ? group.items : [];
    const liveIds = new Set(items.map((item) => item?.id).filter(Boolean));
    const fresh = items
      .filter((item) => item?.id && !prevSet.has(item.id))
      .sort(compareActivityThenKey);
    const keptIds = prev.filter((id) => liveIds.has(id));
    order.sessions.set(group.key, [...keptIds, ...fresh.map((item) => item.id)]);
  }

  return order;
}

/** Sort a display subset. Does not change the remembered order. */
export function sortGroupsBySidebarOrder(groups, order, { unassignedKey = 'Unassigned' } = {}) {
  const projectRank = new Map(order.projects.map((key, index) => [key, index]));
  const sorted = [...(groups || [])].sort((a, b) => {
    const rankOf = (group) => {
      if (projectRank.has(group.key)) return projectRank.get(group.key);
      return group.key === unassignedKey ? 1_000_000 : -1;
    };
    return rankOf(a) - rankOf(b);
  });

  for (const group of sorted) {
    const ranks = new Map((order.sessions.get(group.key) || []).map((id, index) => [id, index]));
    if (!Array.isArray(group.items)) continue;
    group.items.sort((a, b) => {
      const ai = ranks.has(a.id) ? ranks.get(a.id) : Number.MAX_SAFE_INTEGER;
      const bi = ranks.has(b.id) ? ranks.get(b.id) : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  }
  return sorted;
}

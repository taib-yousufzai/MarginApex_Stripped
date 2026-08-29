import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Checks if a target user exists within the hierarchy of an actor user.
 * 
 * Rules:
 * - Super Admins have visibility over everyone.
 * - Admins can view/manage Brokers they created, and Users under those Brokers.
 * - Brokers can view/manage their own Users.
 * - Users can only view themselves.
 */
/**
 * Retrieves all descendant user IDs (direct children, grandchildren, etc.) under a parent ID.
 */
export async function getDescendants(
  supabase: SupabaseClient,
  parentId: string
): Promise<string[]> {
  const { data: profiles, error } = await supabase
    .from('profiles')
    .select('id, parent_id');

  if (error || !profiles) {
    console.error('[getDescendants] Error fetching profiles:', error);
    return [];
  }

  const childrenMap = new Map<string, string[]>();
  for (const p of profiles) {
    if (p.parent_id) {
      const list = childrenMap.get(p.parent_id) || [];
      list.push(p.id);
      childrenMap.set(p.parent_id, list);
    }
  }

  const descendants: string[] = [];
  const queue = [parentId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = childrenMap.get(current) || [];
    for (const childId of children) {
      descendants.push(childId);
      queue.push(childId);
    }
  }

  return descendants;
}

/**
 * Returns accessible user IDs for a given caller.
 * - super_admin: returns null (unrestricted access)
 * - admin / broker: returns array of descendant user IDs
 * - user: returns [callerId]
 */
export async function getAccessibleUserIds(
  supabase: SupabaseClient,
  callerId: string,
  callerRole: string
): Promise<string[] | null> {
  if (callerRole === 'super_admin') {
    return null; // unrestricted
  }

  if (callerRole === 'admin' || callerRole === 'broker') {
    return await getDescendants(supabase, callerId);
  }

  if (callerRole === 'user') {
    return [callerId];
  }

  return [];
}

/**
 * Checks if a target user exists within the hierarchy of an actor user.
 * 
 * Rules:
 * - Super Admins have visibility over everyone.
 * - Admins can view/manage Brokers they created, and Users under those Brokers.
 * - Brokers can view/manage their own Users.
 * - Users can only view themselves.
 */
export async function isUserInHierarchy(
  supabase: SupabaseClient,
  actorId: string,
  targetUserId: string
): Promise<boolean> {
  if (actorId === targetUserId) {
    return true;
  }

  const { data: actorData, error: actorError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', actorId)
    .single();

  if (actorError || !actorData) {
    console.error('Error fetching actor role:', actorError);
    return false;
  }

  const role = actorData.role;

  if (role === 'super_admin') {
    return true;
  }

  if (role === 'user') {
    return false;
  }

  const accessibleIds = await getAccessibleUserIds(supabase, actorId, role);
  if (accessibleIds === null) return true;
  return accessibleIds.includes(targetUserId);
}


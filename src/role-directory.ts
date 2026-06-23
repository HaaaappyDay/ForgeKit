import { loadRoleConfig } from "./project-config.js";

export interface CandidateProfile {
  id: string;
  name: string;
  one_line_responsibility: string;
  when?: string;
}

function oneLineResponsibility(responsibilities: string[], description: string): string {
  const first = responsibilities.find((entry) => entry.trim().length > 0);
  const source = first ?? description ?? "";
  return source.split(/\r?\n/)[0]?.trim() ?? "";
}

/**
 * Builds the minimal candidate-role directory injected into work calls so the
 * active role can pick its next hop (spec §9). Only the candidate set is included,
 * and only the slim fields (id / name / one-line responsibility / optional `when`).
 * `whenByRole` carries the current role's `must_handoff_to[].when` hints.
 */
export async function buildCandidateDirectory(
  candidateRoleIds: string[],
  options: { projectRoot?: string; whenByRole?: Record<string, string> } = {}
): Promise<CandidateProfile[]> {
  const { projectRoot = process.cwd(), whenByRole = {} } = options;
  const seen = new Set<string>();
  const profiles: CandidateProfile[] = [];

  for (const roleId of candidateRoleIds) {
    if (seen.has(roleId)) continue;
    seen.add(roleId);

    const { role } = await loadRoleConfig(roleId, projectRoot);
    const profile: CandidateProfile = {
      id: role.id,
      name: role.name,
      one_line_responsibility: oneLineResponsibility(role.responsibilities, role.description)
    };
    const when = whenByRole[roleId];
    if (when && when.trim().length > 0) {
      profile.when = when;
    }
    profiles.push(profile);
  }

  return profiles;
}

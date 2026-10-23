import React from 'react';

/**
 * Official organization logo assets located in /orgs/
 */
export const ORG_LOGOS = {
  fire_brigade: '/orgs/bombeiroslogo.png',
  gnr: '/orgs/logognrtipo.png',
  inem: '/orgs/INEM_logo.png',
  civil_protection: '/orgs/ANEPC_logo.png',
  psp: '/orgs/logopsp.png',
} as const;

export type KnownOrgType = keyof typeof ORG_LOGOS;

/**
 * Finds the appropriate organization logo URL based on organization type,
 * name, short name, or facility kind.
 */
export function getOrgLogo(
  identifier?:
    | string
    | { type?: string; name?: string; shortName?: string }
    | null,
): string | null {
  if (!identifier) return null;

  if (typeof identifier === 'object') {
    const fromType = getOrgLogo(identifier.type);
    if (fromType) return fromType;
    const fromShort = getOrgLogo(identifier.shortName);
    if (fromShort) return fromShort;
    return getOrgLogo(identifier.name);
  }

  const raw = identifier.trim().toLowerCase();

  // Exact type keys
  if (raw === 'fire_brigade' || raw === 'fire_station' || raw === 'bombeiros') {
    return ORG_LOGOS.fire_brigade;
  }
  if (raw === 'gnr' || raw === 'gnr_post') {
    return ORG_LOGOS.gnr;
  }
  if (raw === 'psp' || raw === 'policia de seguranca publica' || raw === 'polícia de segurança pública') {
    return ORG_LOGOS.psp;
  }
  if (raw === 'inem' || raw === 'inem_base' || raw === 'hospital' || raw === 'health_centre') {
    return ORG_LOGOS.inem;
  }
  if (raw === 'civil_protection' || raw === 'civil_protection_hq' || raw === 'anepc' || raw === 'protecao civil' || raw === 'proteção civil') {
    return ORG_LOGOS.civil_protection;
  }

  // Name matchers
  if (raw.includes('bombeir') || raw.includes('bvc') || raw.startsWith('bv ') || raw.startsWith('cb ')) {
    return ORG_LOGOS.fire_brigade;
  }
  if (raw.includes('gnr') || raw.includes('guarda nacional republicana')) {
    return ORG_LOGOS.gnr;
  }
  if (raw.includes('polícia de segurança pública') || raw.includes('policia de seguranca publica') || /\bpsp\b/.test(raw)) {
    return ORG_LOGOS.psp;
  }
  if (raw.includes('inem') || raw.includes('vmer') || raw.includes('siv') || raw.includes('médic') || raw.includes('medic')) {
    return ORG_LOGOS.inem;
  }
  if (raw.includes('anepc') || raw.includes('proteção civil') || raw.includes('protecao civil')) {
    return ORG_LOGOS.civil_protection;
  }

  return null;
}

export interface OrgLogoProps {
  org?: string | { type?: string; name?: string; shortName?: string } | null;
  kind?: string | null;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  inline?: boolean;
  alt?: string;
}

/**
 * Reusable component to render crisp, authentic organization crests and logos.
 */
export function OrgLogo({ org, kind, size = 28, className = '', style: customStyle, inline = false, alt }: OrgLogoProps) {
  const logoUrl = getOrgLogo(org) || getOrgLogo(kind);
  if (!logoUrl) return null;

  const style: React.CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
    objectFit: 'contain',
    display: inline ? 'inline-block' : 'block',
    verticalAlign: 'middle',
    borderRadius: '4px',
    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))',
    flexShrink: 0,
    ...customStyle,
  };

  return React.createElement('img', {
    src: logoUrl,
    alt: alt ?? 'Logótipo da organização',
    style,
    className,
    loading: 'lazy',
  });
}

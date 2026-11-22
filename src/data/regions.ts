import type { Region } from './languages.ts'

/**
 * Display metadata for each region, in a west-to-east reading order. Map
 * anchors are deliberately absent: they belong to the map's projection and
 * arrive with it.
 */
export const REGIONS: readonly { id: Region; label: string }[] = [
  { id: 'north-america', label: 'North America' },
  { id: 'latin-america', label: 'Latin America' },
  { id: 'west-europe', label: 'Western Europe' },
  { id: 'north-europe', label: 'Northern Europe' },
  { id: 'central-europe', label: 'Central Europe' },
  { id: 'east-europe', label: 'Eastern Europe' },
  { id: 'middle-east', label: 'Middle East' },
  { id: 'north-africa', label: 'North Africa' },
  { id: 'west-africa', label: 'West Africa' },
  { id: 'east-africa', label: 'East & Southern Africa' },
  { id: 'south-asia', label: 'South & Central Asia' },
  { id: 'east-asia', label: 'East Asia' },
  { id: 'southeast-asia', label: 'Southeast Asia' },
  { id: 'oceania', label: 'Oceania' },
]

const LABELS = new Map(REGIONS.map((r) => [r.id, r.label]))

export function regionLabel(id: Region): string {
  return LABELS.get(id) ?? id
}

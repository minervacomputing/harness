import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { Segmented, SegmentedItem } from '@/components/ui/tabs'
import { useTheme } from '@/lib/theme'

const CHOICES = [
  { value: 'light', label: 'Light', icon: SunIcon },
  { value: 'dark', label: 'Dark', icon: MoonIcon },
  { value: 'system', label: 'System', icon: MonitorIcon },
] as const

export function ThemeToggle({ labelled = false, className }: { labelled?: boolean; className?: string }) {
  const { choice, setTheme } = useTheme()
  return (
    <Segmented values={CHOICES.map(c => c.value)} value={choice} onValueChange={setTheme} aria-label="Theme" className={className}>
      {CHOICES.map(c => (
        <SegmentedItem key={c.value} value={c.value} aria-label={labelled ? undefined : c.label} title={labelled ? undefined : c.label} className="flex-1 px-2">
          <c.icon />
          {labelled && c.label}
        </SegmentedItem>
      ))}
    </Segmented>
  )
}

import { useSyncExternalStore } from 'react'

export type ThemeChoice = 'light' | 'dark' | 'system'

// index.html applies the same key before first paint, so keep the two in step.
const KEY = 'minerva-theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')
const listeners = new Set<() => void>()

function read(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY)
    if (value === 'light' || value === 'dark') return value
  } catch { /* storage blocked: follow the system */ }
  return 'system'
}

function apply() {
  const choice = read()
  const dark = choice === 'dark' || (choice === 'system' && media.matches)
  document.documentElement.classList.toggle('dark', dark)
  listeners.forEach(fn => fn())
}

media.addEventListener('change', apply)

export function setTheme(choice: ThemeChoice) {
  try {
    if (choice === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, choice)
  } catch { /* storage blocked: applies for this page only */ }
  apply()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useTheme() {
  const choice = useSyncExternalStore(subscribe, read)
  return { choice, setTheme }
}

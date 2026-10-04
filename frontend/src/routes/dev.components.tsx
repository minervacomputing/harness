import { createFileRoute, notFound } from '@tanstack/react-router'
import { ArrowUpIcon, PlusIcon, SearchIcon, TrashIcon } from 'lucide-react'
import { type ComponentProps, type ReactNode, useState } from 'react'
import { Logo, LogoMark } from '@/components/brand/logo'
import { ToolCall } from '@/components/chat/thread'
import { AppIcon } from '@/components/connections/app-icon'
import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Label, Select, Textarea } from '@/components/ui/input'
import {
  Alert,
  Badge,
  Checkbox,
  ErrorNote,
  Kbd,
  Notice,
  PageHeader,
  Progress,
  RadioGroup,
  RadioItem,
  Spinner,
  Status,
  Switch,
} from '@/components/ui/misc'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Segmented, SegmentedItem, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

// Development only: every component in the design system, in both themes.
// Keep this page up to date when you add or change a component (see .agents/skills/minerva-design).
export const Route = createFileRoute('/dev/components')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound()
  },
  component: ComponentsPage,
})

type Layout = 'single' | 'both'

function ComponentsPage() {
  const [layout, setLayout] = useState<Layout>('single')
  return (
    <div className="min-h-svh bg-background">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b bg-background px-6 py-3">
        <Logo height={24} />
        <span className="label">Components · dev only</span>
        <div className="ml-auto flex items-center gap-3">
          <Segmented value={layout} onValueChange={value => setLayout(value as Layout)} aria-label="Layout">
            <SegmentedItem value="single">Current theme</SegmentedItem>
            <SegmentedItem value="both">Light and dark</SegmentedItem>
          </Segmented>
          {layout === 'single' && <ThemeToggle />}
        </div>
      </header>
      {layout === 'single'
        ? <Catalogue />
        : (
            <div className="grid xl:grid-cols-2">
              <div className="light bg-background text-foreground"><Catalogue /></div>
              <div className="dark border-l bg-background text-foreground"><Catalogue /></div>
            </div>
          )}
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 border-b px-6 py-8">
      <div className="space-y-1">
        <h2 className="label text-foreground">{title}</h2>
        {note && <p className="max-w-2xl text-[13px] text-muted-foreground">{note}</p>}
      </div>
      {children}
    </section>
  )
}

function Row({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center gap-3', className)}>{children}</div>
}

const COLOURS = [
  ['background', 'bg-background'],
  ['card', 'bg-card'],
  ['secondary', 'bg-secondary'],
  ['sidebar', 'bg-sidebar'],
  ['border', 'bg-border'],
  ['border-strong', 'bg-border-strong'],
  ['foreground', 'bg-foreground'],
  ['muted-foreground', 'bg-muted-foreground'],
  ['faint', 'bg-faint'],
  ['primary', 'bg-primary'],
  ['info', 'bg-info'],
  ['success', 'bg-success'],
  ['warning', 'bg-warning'],
  ['destructive', 'bg-destructive'],
  ['logo', 'bg-logo'],
] as const

const TOOL = ToolCall as unknown as (props: Partial<ComponentProps<typeof ToolCall>>) => ReactNode

function Catalogue() {
  const [tab, setTab] = useState('all')
  const [checked, setChecked] = useState(true)
  return (
    <div>
      <Section title="Logo" note="Ruled mark from 40px, solid mark from 20 to 32px, the owl alone at 16px. The colour follows the logo token.">
        <Row className="gap-8">
          <Logo height={64} />
          <Logo height={32} />
          <Logo height={22} />
        </Row>
        <Row className="gap-6">
          {[64, 40, 32, 24, 16].map(size => (
            <div key={size} className="grid justify-items-center gap-2">
              <LogoMark size={size} />
              <span className="font-mono text-[11px] text-muted-foreground">{size}</span>
            </div>
          ))}
        </Row>
      </Section>

      <Section title="App icons" note="Monochrome marks in a square tile, in the foreground colour. Apps without a mark get a plain glyph.">
        <Row className="gap-3">
          {['google_drive', 'gmail', 'github', 'notion', 'linear', 'todoist', 'slack', 'outlook', 'web', 'unknown'].map(slug => (
            <AppIcon key={slug} slug={slug} />
          ))}
        </Row>
        <Row className="gap-3">
          {['google_drive', 'github', 'slack'].map(slug => <AppIcon key={slug} slug={slug} size="sm" />)}
        </Row>
        <Row className="gap-1">
          {['google_drive', 'github', 'slack'].map(slug => <AppIcon key={slug} slug={slug} size="xs" />)}
        </Row>
      </Section>

      <Section title="Colour" note="Tokens from src/index.css. Use them by name; never hard-code a colour.">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] border-t border-l">
          {COLOURS.map(([name, bg]) => (
            <div key={name} className="border-r border-b">
              <div className={cn('h-12 border-b', bg)} />
              <p className="px-2 py-1.5 font-mono text-[11px]">{name}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type" note="IBM Plex Sans for the interface, IBM Plex Mono for labels, identifiers and numbers.">
        <div className="space-y-3">
          <p className="text-2xl font-medium tracking-[-0.015em]">Page heading, 24 medium</p>
          <p className="text-xl font-medium tracking-[-0.015em]">Section heading, 20 medium</p>
          <p className="font-semibold">Card title, 14 semibold</p>
          <p>Body text, 14 regular. Agents only reach what you allow under Connections.</p>
          <p className="text-[13px] text-muted-foreground">Secondary text, 13 muted.</p>
          <p className="label">Label · mono uppercase</p>
          <p className="font-mono text-[13px]">todoist_create_task · 1,204 calls · 0.42s</p>
        </div>
      </Section>

      <PageHeader
        title="Page header"
        description="Title, description and actions at the top of each page."
        actions={<Button><PlusIcon /> Action</Button>}
      />

      <Section title="Buttons" note="Content is always centred. Primary once per view; outline for everything else.">
        <Row>
          <Button>Primary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Delete</Button>
          <Button variant="ghost-destructive"><TrashIcon /> Remove</Button>
          <Button variant="link">Link</Button>
        </Row>
        <Row>
          <Button size="lg">Large</Button>
          <Button size="sm">Small</Button>
          <Button size="sm" variant="outline"><SearchIcon /> Search</Button>
          <Button size="icon" aria-label="Send"><ArrowUpIcon /></Button>
          <Button size="icon-sm" variant="outline" aria-label="Add"><PlusIcon /></Button>
          <Button disabled>Disabled</Button>
          <Button variant="outline" className="w-56">Full width</Button>
        </Row>
      </Section>

      <Section title="Fields">
        <div className="grid max-w-xl gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="dev-email">Email</Label>
            <Input id="dev-email" placeholder="ada@example.com" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dev-invalid">Invalid</Label>
            <Input id="dev-invalid" aria-invalid defaultValue="not an email" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dev-select">Select</Label>
            <Select id="dev-select" defaultValue="b">
              <option value="a">Planner</option>
              <option value="b">Researcher</option>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="dev-disabled">Disabled</Label>
            <Input id="dev-disabled" disabled placeholder="Not editable" />
          </div>
          <div className="grid gap-2 sm:col-span-2">
            <Label htmlFor="dev-textarea">Instructions</Label>
            <Textarea id="dev-textarea" placeholder="What should this agent do?" />
          </div>
        </div>
      </Section>

      <Section title="Choices">
        <Row className="gap-6">
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox checked={checked} onCheckedChange={value => setChecked(value === true)} /> Read tasks
          </label>
          <label className="flex items-center gap-2 text-[13px]"><Checkbox /> Create tasks</label>
          <label className="flex items-center gap-2 text-[13px]"><Checkbox checked disabled /> Inherited</label>
          <label className="flex items-center gap-2 text-[13px]"><Switch defaultChecked /> Enabled</label>
          <label className="flex items-center gap-2 text-[13px]"><Switch /> Off</label>
        </Row>
        <RadioGroup defaultValue="personal" className="flex gap-6">
          <label className="flex items-center gap-2 text-[13px]"><RadioItem value="personal" /> Personal</label>
          <label className="flex items-center gap-2 text-[13px]"><RadioItem value="shared" /> Shared with the workspace</label>
        </RadioGroup>
      </Section>

      <Section title="Tabs and segmented">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="revoked">Revoked</TabsTrigger>
          </TabsList>
          <TabsContent value={tab} className="text-[13px] text-muted-foreground">Showing {tab} connections.</TabsContent>
        </Tabs>
        <Row>
          <Segmented value="week" onValueChange={() => {}} aria-label="Range">
            <SegmentedItem value="day">Day</SegmentedItem>
            <SegmentedItem value="week">Week</SegmentedItem>
            <SegmentedItem value="month">Month</SegmentedItem>
          </Segmented>
          <ThemeToggle />
        </Row>
      </Section>

      <Section title="Status and tags" note="State is a dot and a word. Tags are for names and counts, not state.">
        <Row className="gap-5">
          <Status tone="success">Active</Status>
          <Status tone="warning">Needs reconnecting</Status>
          <Status tone="danger">Revoked</Status>
          <Status tone="info" live>Running</Status>
          <Status>Off</Status>
        </Row>
        <Row>
          <Badge>Todoist · Personal</Badge>
          <Badge variant="secondary">3 agents</Badge>
          <Badge variant="default">New</Badge>
          <Badge variant="destructive">Blocked</Badge>
        </Row>
      </Section>

      <Section title="Alerts">
        <div className="grid max-w-2xl gap-3">
          <Notice>Connect Todoist under Connections, then add it to this agent.</Notice>
          <Alert tone="warning">
            <div className="flex flex-wrap items-center gap-3">
              <span className="flex-1">Todoist has not allowed Minerva to delete tasks yet.</span>
              <Button size="sm">Allow in Todoist</Button>
            </div>
          </Alert>
          <ErrorNote>Could not load your projects.</ErrorNote>
        </div>
      </Section>

      <Section title="Card">
        <Card className="max-w-md">
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div className="space-y-1.5">
              <CardTitle>Todoist</CardTitle>
              <CardDescription>ada@example.com · shared with the workspace</CardDescription>
            </div>
            <Status tone="success">Active</Status>
          </CardHeader>
          <CardContent className="pt-4 text-[13px] text-muted-foreground">Minerva sees only what Todoist lets it see.</CardContent>
          <CardFooter className="gap-2">
            <Button variant="outline" size="sm">Choose access</Button>
            <Button variant="ghost-destructive" size="sm">Disconnect</Button>
          </CardFooter>
        </Card>
      </Section>

      <Section title="Table" note="A strong rule under the head, hairlines between rows. Numbers in mono, right aligned.">
        <Table className="max-w-2xl">
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead className="w-24">Read</TableHead>
              <TableHead className="w-24">Write</TableHead>
              <TableHead className="w-24 text-right">Tasks</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[['Inbox', true, true, 42], ['Work', true, false, 1204], ['Garden', false, false, 7]].map(([name, read, write, count]) => (
              <TableRow key={String(name)}>
                <TableCell>{name}</TableCell>
                <TableCell><Checkbox defaultChecked={Boolean(read)} aria-label={`Read ${name}`} /></TableCell>
                <TableCell><Checkbox defaultChecked={Boolean(write)} aria-label={`Write ${name}`} /></TableCell>
                <TableCell className="text-right font-mono">{count.toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <Section title="Chat" note="Tool cards show state in the icon colour and a status word.">
        <div className="grid max-w-3xl gap-4">
          <div className="flex justify-end">
            <div className="max-w-[80%] border bg-secondary px-3.5 py-2.5 text-sm">What is due this week?</div>
          </div>
          <TOOL toolName="todoist_list_tasks" args={{ filter: 'due before: next monday' }} result={{ decision: 'allowed', label: 'Todoist: list tasks' }} />
          <TOOL toolName="todoist_delete_task" args={{ id: '8812' }} result={{ decision: 'denied', label: 'Todoist: delete task', message: 'This connection does not allow deleting tasks.' }} />
          <TOOL toolName="todoist_create_task" args={{}} result={{ decision: 'error', label: 'Todoist: create task' }} />
          <TOOL toolName="github_search_issues" args={{ q: 'is:open' }} />
          <div className="prose prose-sm prose-minerva max-w-none">
            <p>You have <strong>three tasks</strong> due this week:</p>
            <ul><li>Send the board report</li><li>Renew the domain</li><li>Plan the offsite</li></ul>
            <pre><code>due before: next monday</code></pre>
          </div>
          <div className="flex items-end gap-2 border border-border-strong bg-card p-2 shadow-(--inset-well)">
            <span className="min-h-9 flex-1 px-2 py-2 text-sm text-faint">Message your agent</span>
            <Button size="icon-sm" aria-label="Send"><ArrowUpIcon /></Button>
          </div>
        </div>
      </Section>

      <Section title="Depth" note="Raise what you press or slide, set in what holds a value, float what sits above the page. Everything else stays flat.">
        <Row className="items-start gap-6">
          {([
            ['Raised', 'shadow-(--raise-surface) border-border-strong'],
            ['Set in', 'shadow-(--inset-well) border-input'],
            ['Floating', 'shadow-(--raise-float) border-border-strong'],
          ] as const).map(([name, cls]) => (
            <div key={name} className={cn('grid h-20 w-40 place-items-center border bg-card text-[13px]', cls)}>{name}</div>
          ))}
        </Row>
      </Section>

      <Section title="Small parts">
        <Row className="gap-6">
          <span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">Search <Kbd>⌘</Kbd><Kbd>K</Kbd></span>
          <Spinner />
          <span className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner className="size-3.5" /> Thinking</span>
          <Progress value={62} className="w-48" />
        </Row>
      </Section>
    </div>
  )
}

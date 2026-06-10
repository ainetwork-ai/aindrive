"use client";

// Live render of every UI primitive in all variants — used to eyeball the
// design system in a real browser (Task 8 of the design-system plan). Not a
// product surface; kept out of production by the page-level prod guard.
import { useState } from "react";
import type { ReactNode } from "react";
import {
  Folder,
  FileText,
  Trash2,
  Share2,
  Download,
  Pencil,
  MoreVertical,
  Plus,
  Info,
  Inbox,
  Star,
  Settings,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  Input,
  Menu,
  Modal,
  Select,
  Skeleton,
  Toggle,
  Tooltip,
} from "@/components/ui";
import type { ButtonVariant } from "@/components/ui";

const VARIANTS: ButtonVariant[] = ["filled", "tonal", "text", "outline", "danger"];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-label uppercase text-drive-muted">{title}</h2>
      <div className="rounded-lg border border-drive-border bg-drive-panel p-6 space-y-6">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-20 shrink-0 text-caption text-drive-muted">{label}</span>
      {children}
    </div>
  );
}

export function Gallery() {
  const [modalOpen, setModalOpen] = useState(false);
  const [footerModal, setFooterModal] = useState(false);
  const [toggleA, setToggleA] = useState(true);
  const [toggleB, setToggleB] = useState(false);
  const [loading, setLoading] = useState(false);

  return (
    <div className="min-h-screen bg-drive-bg text-drive-text">
      <div className="mx-auto max-w-4xl px-6 py-10 space-y-10">
        <header className="space-y-1">
          <h1 className="text-display">Design system</h1>
          <p className="text-body text-drive-muted">
            Every primitive, every variant. Sans face is self-hosted Inter (var(--font-sans)).
          </p>
        </header>

        {/* ---- Typography scale ---- */}
        <Section title="Typography">
          <div className="space-y-1">
            <p className="text-display">Display 28 / 600</p>
            <p className="text-title">Title 20 / 600</p>
            <p className="text-subtitle">Subtitle 16 / 500</p>
            <p className="text-body">Body 14 / 400 — the quick brown fox jumps over the lazy dog.</p>
            <p className="text-caption text-drive-muted">Caption 12 / 400</p>
            <p className="text-label uppercase text-drive-muted">Label 11 / 500 / tracked</p>
          </div>
        </Section>

        {/* ---- Buttons ---- */}
        <Section title="Buttons">
          <Row label="md">
            {VARIANTS.map((v) => (
              <Button key={v} variant={v}>
                {v}
              </Button>
            ))}
          </Row>
          <Row label="sm">
            {VARIANTS.map((v) => (
              <Button key={v} variant={v} size="sm">
                {v}
              </Button>
            ))}
          </Row>
          <Row label="icon">
            <Button icon={<Plus className="w-4 h-4" />}>New</Button>
            <Button variant="outline" icon={<Download className="w-4 h-4" />}>
              Download
            </Button>
          </Row>
          <Row label="loading">
            <Button loading>Saving</Button>
            <Button
              variant="outline"
              loading={loading}
              onClick={() => {
                setLoading(true);
                setTimeout(() => setLoading(false), 1500);
              }}
            >
              Click me
            </Button>
          </Row>
          <Row label="disabled">
            <Button disabled>Disabled</Button>
            <Button variant="outline" disabled>
              Disabled
            </Button>
          </Row>
          <Row label="iconbtn">
            <IconButton aria-label="Edit">
              <Pencil className="w-5 h-5" />
            </IconButton>
            <IconButton aria-label="Share" variant="tonal">
              <Share2 className="w-5 h-5" />
            </IconButton>
            <IconButton aria-label="Delete" variant="danger">
              <Trash2 className="w-5 h-5" />
            </IconButton>
            <IconButton aria-label="Settings" size="sm">
              <Settings className="w-4 h-4" />
            </IconButton>
          </Row>
        </Section>

        {/* ---- Form controls ---- */}
        <Section title="Form controls">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Name" placeholder="Ada Lovelace" helper="Shown to collaborators." />
            <Input label="Email" defaultValue="bad@" error="Enter a valid email." />
            <Select label="Currency" defaultValue="USDC">
              <option value="USDC">USDC</option>
              <option value="FANCO">FANCO</option>
            </Select>
            <Input label="Disabled" placeholder="read-only" disabled />
          </div>
          <Row label="toggle">
            <Toggle on={toggleA} onChange={setToggleA} aria-label="Toggle A" />
            <Toggle on={toggleB} onChange={setToggleB} aria-label="Toggle B" />
            <Toggle on disabled onChange={() => {}} aria-label="Disabled on" />
            <Toggle on={false} disabled onChange={() => {}} aria-label="Disabled off" />
          </Row>
        </Section>

        {/* ---- Menu ---- */}
        <Section title="Menu">
          <Row label="dropdown">
            <Menu
              trigger={({ open: _o, onClick, ...a }) => (
                <Button variant="outline" onClick={onClick} {...a}>
                  Open menu
                </Button>
              )}
              items={[
                { label: "Open", icon: <Folder className="w-4 h-4" />, onClick: () => {} },
                { label: "Download", icon: <Download className="w-4 h-4" />, onClick: () => {} },
                { label: "Rename", icon: <Pencil className="w-4 h-4" />, onClick: () => {} },
                { label: "Delete", icon: <Trash2 className="w-4 h-4" />, onClick: () => {}, danger: true },
              ]}
            />
            <Menu
              align="end"
              trigger={({ open: _o, onClick, ...a }) => (
                <IconButton aria-label="Row actions" onClick={onClick} {...a}>
                  <MoreVertical className="w-5 h-5" />
                </IconButton>
              )}
              items={[
                { label: "Star", icon: <Star className="w-4 h-4" />, onClick: () => {} },
                { label: "Disabled item", onClick: () => {}, disabled: true },
                { label: "Share", icon: <Share2 className="w-4 h-4" />, onClick: () => {} },
              ]}
            />
          </Row>
        </Section>

        {/* ---- Modal ---- */}
        <Section title="Modal">
          <Row label="open">
            <Button onClick={() => setModalOpen(true)}>Basic modal</Button>
            <Button variant="outline" onClick={() => setFooterModal(true)}>
              With footer
            </Button>
          </Row>
          <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Share / project">
            <p className="text-body text-drive-muted">
              Esc, backdrop click, and the close button all dismiss. Tab cycles within this panel; focus
              returns to the opener on close.
            </p>
            <div className="mt-4 space-y-3">
              <Input label="Invite by email" placeholder="name@example.com" />
              <Select label="Role">
                <option>Viewer</option>
                <option>Editor</option>
              </Select>
            </div>
          </Modal>
          <Modal
            open={footerModal}
            onClose={() => setFooterModal(false)}
            title="Delete file?"
            size="sm"
            footer={
              <>
                <Button variant="text" onClick={() => setFooterModal(false)}>
                  Cancel
                </Button>
                <Button variant="danger" onClick={() => setFooterModal(false)}>
                  Delete
                </Button>
              </>
            }
          >
            <p className="text-body">This action cannot be undone.</p>
          </Modal>
        </Section>

        {/* ---- Feedback ---- */}
        <Section title="Feedback">
          <Row label="tooltip">
            <Tooltip content="Tooltip on top">
              <Button variant="outline">Hover me</Button>
            </Tooltip>
            <Tooltip content="On the right" side="right">
              <IconButton aria-label="Info">
                <Info className="w-5 h-5" />
              </IconButton>
            </Tooltip>
          </Row>
          <Row label="badge">
            <Badge>neutral</Badge>
            <Badge tone="accent">accent</Badge>
            <Badge tone="warning">warning</Badge>
            <Badge tone="sale">$5.00</Badge>
          </Row>
          <div className="space-y-2">
            <span className="text-caption text-drive-muted">skeleton</span>
            <div className="flex items-center gap-3">
              <Skeleton width={40} height={40} rounded="full" />
              <div className="flex-1 space-y-2">
                <Skeleton width="60%" />
                <Skeleton width="40%" />
              </div>
            </div>
          </div>
          <div className="rounded-md border border-dashed border-drive-border">
            <EmptyState
              icon={<Inbox />}
              title="No files yet"
              description="Upload a file or create a folder to get started."
              action={<Button icon={<Plus className="w-4 h-4" />}>New</Button>}
            />
          </div>
        </Section>

        {/* ---- Cards & avatars ---- */}
        <Section title="Cards & avatars">
          <div className="grid gap-3 sm:grid-cols-3">
            <Card>
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-drive-accent" />
                <span className="text-subtitle">Static card</span>
              </div>
              <p className="mt-1 text-caption text-drive-muted">Plain surface.</p>
            </Card>
            <Card interactive onClick={() => {}}>
              <div className="flex items-center gap-2">
                <Folder className="w-5 h-5 text-drive-accent" />
                <span className="text-subtitle">Clickable</span>
              </div>
              <p className="mt-1 text-caption text-drive-muted">Hover for elevation.</p>
            </Card>
            <Card interactive onClick={() => {}}>
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-drive-accent" />
                <span className="text-subtitle">design.md</span>
                <Badge tone="sale" className="ml-auto">
                  $5.00
                </Badge>
              </div>
              <p className="mt-1 text-caption text-drive-muted">For sale leaf.</p>
            </Card>
          </div>
          <Row label="avatar">
            <Avatar name="Ada Lovelace" size="lg" />
            <Avatar name="Grace Hopper" />
            <Avatar name="Linus" size="sm" />
            <Avatar name="K" size="xs" />
          </Row>
        </Section>
      </div>
    </div>
  );
}

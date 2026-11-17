/** The small to-do list shown in the island's panel: a JSON file the user can also open and edit. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Profile-relative JSON holding the to-do items. */
export const TODOS_FILE = 'orb-todos.json'

/** Most items kept; adding beyond this is refused so the panel stays readable. */
export const MAX_TODOS = 30

/** Longest text of one item. */
export const MAX_TODO_CHARS = 80

export interface TodoItem {
  readonly id: string
  readonly text: string
  readonly done: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the list.
 * @param profileDir - Desktop profile directory.
 * @returns the items in order; empty when the file is missing or damaged.
 */
export function readTodos(profileDir: string): TodoItem[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(profileDir, TODOS_FILE), 'utf8'))
  } catch {
    // A missing or damaged file is an empty list.
    return []
  }
  const items = isRecord(raw) && Array.isArray(raw.items) ? raw.items : Array.isArray(raw) ? raw : []
  const seen = new Set<string>()
  const todos: TodoItem[] = []
  for (const item of items) {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.text !== 'string' || seen.has(item.id)) continue
    const text = item.text.trim().slice(0, MAX_TODO_CHARS)
    if (text === '') continue
    seen.add(item.id)
    todos.push({ id: item.id, text, done: item.done === true })
  }
  return todos.slice(0, MAX_TODOS)
}

function write(profileDir: string, items: readonly TodoItem[]): void {
  mkdirSync(profileDir, { recursive: true })
  const path = join(profileDir, TODOS_FILE)
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ items }, undefined, 2)}\n`)
  renameSync(temporary, path)
}

/**
 * Add an item at the end.
 * @param profileDir - Desktop profile directory.
 * @param text - what to do; trimmed and cut to {@link MAX_TODO_CHARS}.
 * @returns the list afterwards; unchanged when the text is empty or the list is full.
 */
export function addTodo(profileDir: string, text: string): TodoItem[] {
  const items = readTodos(profileDir)
  const clean = text.trim().slice(0, MAX_TODO_CHARS)
  if (clean === '' || items.length >= MAX_TODOS) return items
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const next = [...items, { id, text: clean, done: false }]
  write(profileDir, next)
  return next
}

/**
 * Tick an item or untick it.
 * @param profileDir - Desktop profile directory.
 * @param id - the item.
 * @returns the list afterwards; unchanged when there is no such item.
 */
export function toggleTodo(profileDir: string, id: string): TodoItem[] {
  const items = readTodos(profileDir)
  if (!items.some(item => item.id === id)) return items
  const next = items.map(item => (item.id === id ? { ...item, done: !item.done } : item))
  write(profileDir, next)
  return next
}

/**
 * Remove an item.
 * @param profileDir - Desktop profile directory.
 * @param id - the item.
 * @returns the list afterwards; unchanged when there is no such item.
 */
export function removeTodo(profileDir: string, id: string): TodoItem[] {
  const items = readTodos(profileDir)
  if (!items.some(item => item.id === id)) return items
  const next = items.filter(item => item.id !== id)
  write(profileDir, next)
  return next
}

/**
 * Whether the file exists yet.
 * @param profileDir - Desktop profile directory.
 * @returns true once any change has been saved.
 */
export function todosFileExists(profileDir: string): boolean {
  return existsSync(join(profileDir, TODOS_FILE))
}

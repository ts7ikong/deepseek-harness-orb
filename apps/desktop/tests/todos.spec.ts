import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addTodo, MAX_TODO_CHARS, MAX_TODOS, readTodos, removeTodo, toggleTodo, TODOS_FILE } from '../src/todos.ts'
import { alignOffWork, defaultReminderConfig, nextReminder } from '../src/reminders.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-todos-'))
  roots.push(root)
  return root
}

describe('the to-do list', () => {
  it('starts empty, and keeps what is added, in order', () => {
    const root = temp()
    expect(readTodos(root)).toEqual([])
    addTodo(root, '  回复甲客户  ')
    addTodo(root, '部署乙系统')
    expect(readTodos(root).map(item => [item.text, item.done])).toEqual([['回复甲客户', false], ['部署乙系统', false]])
  })

  it('ignores blank text, cuts a long one, and stops at the limit', () => {
    const root = temp()
    expect(addTodo(root, '   ')).toEqual([])
    expect(addTodo(root, 'x'.repeat(200))[0]?.text).toHaveLength(MAX_TODO_CHARS)
    for (let index = 1; index < MAX_TODOS + 5; index += 1) addTodo(root, `事项 ${String(index)}`)
    expect(readTodos(root)).toHaveLength(MAX_TODOS)
  })

  it('ticks, unticks, and removes an item, and leaves the list alone for an unknown id', () => {
    const root = temp()
    const [first] = addTodo(root, '甲')
    addTodo(root, '乙')
    toggleTodo(root, first!.id)
    expect(readTodos(root).map(item => item.done)).toEqual([true, false])
    toggleTodo(root, first!.id)
    expect(readTodos(root).map(item => item.done)).toEqual([false, false])
    expect(toggleTodo(root, 'nope')).toHaveLength(2)
    removeTodo(root, first!.id)
    expect(readTodos(root).map(item => item.text)).toEqual(['乙'])
    expect(removeTodo(root, 'nope')).toHaveLength(1)
  })

  it('survives a damaged or hand-edited file, keeping the usable items', () => {
    const root = temp()
    writeFileSync(join(root, TODOS_FILE), '{oops')
    expect(readTodos(root)).toEqual([])
    writeFileSync(join(root, TODOS_FILE), JSON.stringify({ items: [
      { id: 'a', text: '好的', done: true },
      { id: 'a', text: '重复的 id' },
      { id: 'b', text: '   ' },
      { text: '没有 id' },
      { id: 'c', text: '另一条' },
    ] }))
    expect(readTodos(root)).toEqual([{ id: 'a', text: '好的', done: true }, { id: 'c', text: '另一条', done: false }])
  })
})

describe('nextReminder', () => {
  // 2026-10-28 is a Wednesday.
  const config = defaultReminderConfig()
  const at = (day: number, hour: number, minute = 0): Date => new Date(2026, 9, day, hour, minute, 0)
  const none = { date: '', ids: [] as string[] }

  it('is the earliest one still to come today', () => {
    const next = nextReminder(config, at(28, 10), none)
    expect(next?.entry.id).toBe('daily-report')
    expect(next?.at).toEqual(at(28, 18, 20))
    expect(nextReminder(config, at(28, 18, 25), none)?.entry.id).toBe('off-work')
  })

  it('skips one that already fired today, and moves on to the next day after the last one', () => {
    expect(nextReminder(config, at(28, 10), { date: '2026-10-28', ids: ['daily-report'] })?.entry.id).toBe('off-work')
    const tomorrow = nextReminder(config, at(28, 19), none)
    expect(tomorrow?.entry.id).toBe('daily-report')
    expect(tomorrow?.at).toEqual(at(29, 18, 20))
  })

  it('finds the Friday weekly report from the weekend, and nothing when reminders are off', () => {
    // 2026-10-24 is a Saturday; the next workday reminder is Monday's daily report.
    expect(nextReminder(config, at(24, 12), none)?.at).toEqual(at(26, 18, 20))
    expect(nextReminder({ ...config, reminders: config.reminders.filter(entry => entry.id === 'weekly-report') }, at(24, 12), none)?.at)
      .toEqual(at(30, 9, 30))
    expect(nextReminder({ ...config, enabled: false }, at(28, 10), none)).toBeUndefined()
    expect(nextReminder({ ...config, reminders: [] }, at(28, 10), none)).toBeUndefined()
  })

  it('follows the user\'s off-work time when the config is aligned', () => {
    const aligned = alignOffWork(config, 17 * 60)
    expect(nextReminder({ ...aligned, reminders: aligned.reminders.filter(entry => entry.id === 'off-work') }, at(28, 10), none)?.at)
      .toEqual(at(28, 17, 0))
  })
})

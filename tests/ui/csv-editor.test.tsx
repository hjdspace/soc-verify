// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mocks ──────────────────────────────────────────────────────

const { trpc } = vi.hoisted(() => ({
  trpc: {
    project: {
      readFile: {
        query: vi.fn(),
      },
      writeFile: { mutate: vi.fn().mockResolvedValue(undefined) },
    },
  },
}));

vi.mock('@renderer/lib/trpc', () => ({ trpc }));

vi.mock('@renderer/stores/theme', () => ({
  useThemeStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        currentTheme: 'bench',
        themes: [{ id: 'bench', name: 'Bench', mode: 'dark', swatch: '#3ddc84', description: '' }],
      }),
    ),
    { getState: () => ({ currentTheme: 'bench' }) },
  ),
}));

vi.mock('@renderer/stores/toast', () => ({
  useToastStore: Object.assign(
    vi.fn((selector: (state: Record<string, unknown>) => unknown) =>
      selector({ success: vi.fn(), error: vi.fn() }),
    ),
    { getState: () => ({ success: vi.fn(), error: vi.fn() }) },
  ),
}));

// Import after mocks
import { CsvEditor } from '@renderer/components/editor/CsvEditor';

// ── Test data ───────────────────────────────────────────────────

const SAMPLE_CSV = `"Name","Age","City"
"Alice","30","Beijing"
"Bob","25","Shanghai"`;

// ── Tests ───────────────────────────────────────────────────────

describe('CsvEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trpc.project.readFile.query.mockResolvedValue(SAMPLE_CSV);
  });

  // ── Slice 1: loads CSV and renders table ──────────────────────

  it('renders CSV content as an editable table with header and data rows', async () => {
    render(<CsvEditor projectId="proj-1" filePath="/data/users.csv" fileName="users.csv" />);

    // Header cells
    await waitFor(() => {
      expect(screen.getByDisplayValue('Name')).toBeTruthy();
      expect(screen.getByDisplayValue('Age')).toBeTruthy();
      expect(screen.getByDisplayValue('City')).toBeTruthy();
    });

    // Data cells
    expect(screen.getByDisplayValue('Alice')).toBeTruthy();
    expect(screen.getByDisplayValue('30')).toBeTruthy();
    expect(screen.getByDisplayValue('Beijing')).toBeTruthy();
    expect(screen.getByDisplayValue('Bob')).toBeTruthy();
    expect(screen.getByDisplayValue('25')).toBeTruthy();
    expect(screen.getByDisplayValue('Shanghai')).toBeTruthy();
  });

  // ── Slice 2: editing a cell updates the data ─────────────────

  it('allows editing a cell value in the table', async () => {
    render(<CsvEditor projectId="proj-1" filePath="/data/users.csv" fileName="users.csv" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Alice')).toBeTruthy();
    });

    const aliceInput = screen.getByDisplayValue('Alice');
    fireEvent.change(aliceInput, { target: { value: 'Alice Wang' } });

    expect(screen.getByDisplayValue('Alice Wang')).toBeTruthy();
  });

  // ── Slice 3: saving writes serialized CSV back ───────────────

  it('serializes the table back to CSV and saves on button click', async () => {
    render(<CsvEditor projectId="proj-1" filePath="/data/users.csv" fileName="users.csv" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Alice')).toBeTruthy();
    });

    // Edit a cell
    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'Alicia' } });

    // Click save
    const saveButton = screen.getByTitle('保存 (Ctrl+S)');
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(trpc.project.writeFile.mutate).toHaveBeenCalledTimes(1);
    });

    const callArgs = trpc.project.writeFile.mutate.mock.calls[0][0];
    expect(callArgs.projectId).toBe('proj-1');
    expect(callArgs.filePath).toBe('/data/users.csv');
    // The written content should contain the edited value
    expect(callArgs.content).toContain('Alicia');
    // And still contain other original values
    expect(callArgs.content).toContain('Bob');
    expect(callArgs.content).toContain('Shanghai');
  });

  // ── Slice 4: shows "已修改" indicator when dirty ─────────────

  it('shows modified indicator after editing a cell', async () => {
    render(<CsvEditor projectId="proj-1" filePath="/data/users.csv" fileName="users.csv" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Alice')).toBeTruthy();
    });

    // No dirty indicator initially
    expect(screen.queryByText('● 已修改')).toBeNull();

    // Edit a cell
    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'Alicia' } });

    // Dirty indicator should appear
    expect(screen.getByText('● 已修改')).toBeTruthy();
  });

  // ── Slice 5: add row ──────────────────────────────────────────

  it('adds a new empty row when clicking the add row button', async () => {
    render(<CsvEditor projectId="proj-1" filePath="/data/users.csv" fileName="users.csv" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Alice')).toBeTruthy();
    });

    // Initially 2 data rows (4 data rows = header + 2 data)
    const inputsBefore = screen.getAllByRole('textbox').length;
    // 3 header + 6 data = 9 inputs
    expect(inputsBefore).toBe(9);

    // Click "添加行"
    fireEvent.click(screen.getByText('添加行'));

    // Should have one more row (3 columns)
    const inputsAfter = screen.getAllByRole('textbox').length;
    expect(inputsAfter).toBe(12);
  });

  // ── Slice 6: handles CSV with quoted commas ───────────────────

  it('correctly parses CSV cells containing quoted commas', async () => {
    const csvWithCommas = `"Name","Description"
"Test","Hello, World"
"Item 2","Foo, Bar"`;

    trpc.project.readFile.query.mockResolvedValue(csvWithCommas);

    render(<CsvEditor projectId="proj-1" filePath="/data/items.csv" fileName="items.csv" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Hello, World')).toBeTruthy();
    });

    expect(screen.getByDisplayValue('Foo, Bar')).toBeTruthy();
  });

  // ── Slice 7: handles empty file gracefully ────────────────────

  it('handles empty CSV file by showing an empty table with add row button', async () => {
    trpc.project.readFile.query.mockResolvedValue('');

    render(<CsvEditor projectId="proj-1" filePath="/data/empty.csv" fileName="empty.csv" />);

    await waitFor(() => {
      // Should have the add row button available
      expect(screen.getByText('添加行')).toBeTruthy();
    });

    // No input cells initially (empty file = no rows)
    expect(screen.queryAllByRole('textbox').length).toBe(0);
  });

  // ── Slice 8: Ctrl+S triggers save ─────────────────────────────

  it('triggers save on Ctrl+S keyboard shortcut', async () => {
    render(<CsvEditor projectId="proj-1" filePath="/data/users.csv" fileName="users.csv" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Alice')).toBeTruthy();
    });

    // Edit to make it dirty
    fireEvent.change(screen.getByDisplayValue('Alice'), { target: { value: 'Alicia' } });

    // Press Ctrl+S
    fireEvent.keyDown(window, { key: 's', ctrlKey: true });

    await waitFor(() => {
      expect(trpc.project.writeFile.mutate).toHaveBeenCalledTimes(1);
    });
  });

  // ── Slice 9: add column ───────────────────────────────────────

  it('adds a new empty column when clicking the add column button', async () => {
    render(<CsvEditor projectId="proj-1" filePath="/data/users.csv" fileName="users.csv" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Alice')).toBeTruthy();
    });

    // Initially 3 columns × 3 rows (header + 2 data) = 9 inputs
    expect(screen.getAllByRole('textbox').length).toBe(9);

    // Click "添加列"
    fireEvent.click(screen.getByText('添加列'));

    // 4 columns × 3 rows = 12 inputs
    expect(screen.getAllByRole('textbox').length).toBe(12);
  });

  // ── Slice 10: delete row ──────────────────────────────────────

  it('deletes a data row when clicking the delete row button', async () => {
    render(<CsvEditor projectId="proj-1" filePath="/data/users.csv" fileName="users.csv" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Alice')).toBeTruthy();
    });

    // Initially 9 inputs (3 cols × 3 rows)
    expect(screen.getAllByRole('textbox').length).toBe(9);

    // Click the first delete-row button
    const deleteButtons = screen.getAllByTitle('删除行');
    expect(deleteButtons.length).toBe(2); // 2 data rows
    fireEvent.click(deleteButtons[0]);

    // 3 cols × 2 rows = 6 inputs (Alice row deleted)
    expect(screen.getAllByRole('textbox').length).toBe(6);
    expect(screen.queryByDisplayValue('Alice')).toBeNull();
    // Bob should still be there
    expect(screen.getByDisplayValue('Bob')).toBeTruthy();
  });
});

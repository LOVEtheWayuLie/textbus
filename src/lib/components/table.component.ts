import { Injector } from '@tanbo/di';

import {
  Fragment,
  SlotMap,
  ComponentLoader,
  VElement,
  ViewData,
  BackboneAbstractComponent, SlotRendererFn, Component, Interceptor, TBSelection, TBEvent
} from '../core/_api';
import { BrComponent } from './br.component';

export interface TableCell {
  colspan: number;
  rowspan: number;
  fragment: Fragment;
}

export interface TableCellPosition {
  beforeCell: TableCell;
  afterCell: TableCell;
  row: TableCell[];
  cell: TableCell,
  rowIndex: number;
  columnIndex: number;
  offsetColumn: number;
  offsetRow: number;
}

export interface TableRowPosition {
  cells: TableCell[];
  beforeRow: TableCell[];
  afterRow: TableCell[];
  cellsPosition: TableCellPosition[];
}

export interface TableInitParams {
  // headers?: TableCell[][];
  useTextBusStyle: boolean;
  bodies: TableCell[][];
}

export interface TableCellRect {
  minRow: number;
  maxRow: number;
  minColumn: number;
  maxColumn: number;
}

export interface TableRange {
  startCellPosition: TableCellPosition;
  endCellPosition: TableCellPosition;
  selectedCells: Fragment[];
}

class TableComponentLoader implements ComponentLoader {
  private tagName = 'table';

  match(component: HTMLElement): boolean {
    return component.nodeName.toLowerCase() === this.tagName;
  }

  read(el: HTMLTableElement): ViewData {
    const {tHead, tBodies, tFoot} = el;
    const slots: SlotMap[] = [];
    const headers: TableCell[][] = [];
    const bodies: TableCell[][] = [];
    if (tHead) {
      Array.from(tHead.rows).forEach(row => {
        const arr: TableCell[] = [];
        headers.push(arr);
        Array.from(row.cells).forEach(cell => {
          const fragment = new Fragment();
          arr.push({
            rowspan: cell.rowSpan,
            colspan: cell.colSpan,
            fragment
          });
          slots.push({
            from: cell,
            toSlot: fragment
          });
        })
      });
    }

    if (tBodies) {
      Array.of(...Array.from(tBodies), tFoot || {rows: []}).reduce((value, next) => {
        return value.concat(Array.from(next.rows));
      }, [] as HTMLTableRowElement[]).forEach(row => {
        const arr: TableCell[] = [];
        bodies.push(arr);
        Array.from(row.cells).forEach(cell => {
          const fragment = new Fragment();
          arr.push({
            rowspan: cell.rowSpan,
            colspan: cell.colSpan,
            fragment
          });
          slots.push({
            from: cell,
            toSlot: fragment
          });
        })
      });
    }
    bodies.unshift(...headers);
    return {
      component: new TableComponent({
        // headers,
        useTextBusStyle: el.classList.contains('tb-table'),
        bodies
      }),
      slotsMap: slots
    };
  }
}

class TableComponentInterceptor implements Interceptor<TableComponent> {
  private selection: TBSelection;

  setup(injector: Injector) {
    this.selection = injector.get(TBSelection);
  }

  onEnter(event: TBEvent<TableComponent>) {
    const firstRange = this.selection.firstRange;
    const slot = this.selection.commonAncestorFragment;
    slot.insert(new BrComponent(), firstRange.startIndex);
    firstRange.startIndex = firstRange.endIndex = firstRange.startIndex + 1;
    const afterContent = slot.sliceContents(firstRange.startIndex, firstRange.startIndex + 1)[0];
    if (!afterContent) {
      slot.append(new BrComponent());
    }
    event.stopPropagation();
  }

  onDelete(event: TBEvent<TableComponent>) {
    if (this.selection.firstRange.startIndex === 0) {
      event.stopPropagation();
    }
  }
}

@Component({
  loader: new TableComponentLoader(),
  interceptor: new TableComponentInterceptor()
})
export class TableComponent extends BackboneAbstractComponent {
  get cellMatrix() {
    const n = this.serialize();
    this._cellMatrix = n;
    return n;
  }

  private _cellMatrix: TableRowPosition[];
  private deleteMarkFragments: Fragment[] = [];

  constructor(public config: TableInitParams) {
    super('table')
    const bodyConfig = config.bodies;
    const cells = [];
    for (const row of bodyConfig) {
      cells.push(...row.map(i => i.fragment));
    }
    this.push(...cells);
  }

  canDelete(deletedSlot: Fragment): boolean {
    this.deleteMarkFragments.push(deletedSlot);
    return !this.map(slot => this.deleteMarkFragments.includes(slot)).includes(false);
  }

  clone() {
    const clone = function (rows: TableCell[][]) {
      return rows.map(row => {
        return row.map(cell => {
          return {
            ...cell,
            fragment: cell.fragment.clone()
          };
        })
      });
    }

    const config: TableInitParams = {
      // headers: this.config.headers ? clone(this.config.headers) : null,
      useTextBusStyle: this.config.useTextBusStyle,
      bodies: clone(this.config.bodies)
    }
    return new TableComponent(config);
  }

  componentDataChange() {
    this.clean();
    this.config.bodies.forEach(row => {
      row.forEach(cell => {
        this.push(cell.fragment);
      })
    })
  }

  render(isOutputMode: boolean, slotRendererFn: SlotRendererFn) {
    const table = new VElement(this.tagName);
    if (this.config.useTextBusStyle) {
      table.classes.push('tb-table');
    }
    this.deleteMarkFragments = [];
    const bodyConfig = this.config.bodies;
    if (bodyConfig.length) {
      const body = new VElement('tbody');
      table.appendChild(body);
      for (const row of bodyConfig) {
        const tr = new VElement('tr');
        body.appendChild(tr);
        for (const col of row) {
          const td = new VElement('td');
          if (col.colspan > 1) {
            td.attrs.set('colspan', col.colspan);
          }
          if (col.rowspan > 1) {
            td.attrs.set('rowspan', col.rowspan);
          }
          if (col.fragment.contentLength === 0) {
            col.fragment.append(new BrComponent());
          }
          tr.appendChild(slotRendererFn(col.fragment, td));
        }
      }
    }
    return table;
  }

  selectCells(startCell: Fragment, endCell: Fragment) {
    this._cellMatrix = this.serialize();
    const p1 = this.findCellPosition(startCell);
    const p2 = this.findCellPosition(endCell);
    const minRow = Math.min(p1.minRow, p2.minRow);
    const minColumn = Math.min(p1.minColumn, p2.minColumn);
    const maxRow = Math.max(p1.maxRow, p2.maxRow);
    const maxColumn = Math.max(p1.maxColumn, p2.maxColumn);
    return this.selectCellsByRange(minRow, minColumn, maxRow, maxColumn);
  }

  private selectCellsByRange(minRow: number, minColumn: number, maxRow: number, maxColumn: number): TableRange {
    const cellMatrix = this._cellMatrix;
    const x1 = -Math.max(...cellMatrix.slice(minRow, maxRow + 1).map(row => row.cellsPosition[minColumn].offsetColumn));
    const x2 = Math.max(...cellMatrix.slice(minRow, maxRow + 1).map(row => {
      return row.cellsPosition[maxColumn].cell.colspan - (row.cellsPosition[maxColumn].offsetColumn + 1);
    }));
    const y1 = -Math.max(...cellMatrix[minRow].cellsPosition.slice(minColumn, maxColumn + 1).map(cell => cell.offsetRow));
    const y2 = Math.max(...cellMatrix[maxRow].cellsPosition.slice(minColumn, maxColumn + 1).map(cell => {
      return cell.cell.rowspan - (cell.offsetRow + 1);
    }));

    if (x1 || y1 || x2 || y2) {
      return this.selectCellsByRange(minRow + y1, minColumn + x1, maxRow + y2, maxColumn + x2);
    }

    const startCellPosition = cellMatrix[minRow].cellsPosition[minColumn];
    const endCellPosition = cellMatrix[maxRow].cellsPosition[maxColumn];

    const selectedCells = cellMatrix.slice(startCellPosition.rowIndex, endCellPosition.rowIndex + 1).map(row => {
      return row.cellsPosition.slice(startCellPosition.columnIndex, endCellPosition.columnIndex + 1);
    }).reduce((a, b) => {
      return a.concat(b);
    }).map(item => item.cell.fragment);

    return {
      selectedCells: Array.from(new Set(selectedCells)),
      startCellPosition,
      endCellPosition
    }
  }

  private findCellPosition(cell: Fragment): TableCellRect {
    const cellMatrix = this._cellMatrix;
    let minRow: number, maxRow: number, minColumn: number, maxColumn: number;

    forA:for (let rowIndex = 0; rowIndex < cellMatrix.length; rowIndex++) {
      const cells = cellMatrix[rowIndex].cellsPosition;
      for (let colIndex = 0; colIndex < cells.length; colIndex++) {
        if (cells[colIndex].cell.fragment === cell) {
          minRow = rowIndex;
          minColumn = colIndex;
          break forA;
        }
      }
    }

    forB:for (let rowIndex = cellMatrix.length - 1; rowIndex > -1; rowIndex--) {
      const cells = cellMatrix[rowIndex].cellsPosition;
      for (let colIndex = cells.length - 1; colIndex > -1; colIndex--) {
        if (cells[colIndex].cell.fragment === cell) {
          maxRow = rowIndex;
          maxColumn = colIndex;
          break forB;
        }
      }
    }

    return {
      minRow,
      maxRow,
      minColumn,
      maxColumn
    }
  }

  private serialize(): TableRowPosition[] {
    const rows: TableRowPosition[] = [];

    const bodies = this.config.bodies;
    for (let i = 0; i < bodies.length; i++) {
      const cells: TableCellPosition[] = [];
      bodies[i].forEach((cell, index) => {
        cells.push({
          row: bodies[i],
          beforeCell: bodies[i][index - 1],
          afterCell: bodies[i][index + 1],
          offsetColumn: 0,
          offsetRow: 0,
          columnIndex: null,
          rowIndex: null,
          cell
        })
      })
      rows.push({
        beforeRow: bodies[i - 1] || null,
        afterRow: bodies[i + 1] || null,
        cellsPosition: cells,
        cells: bodies[i]
      });
    }

    let stop = false;
    let columnIndex = 0;
    const marks: string[] = [];
    do {
      let rowIndex = 0;
      stop = false;
      while (rowIndex < rows.length) {
        const row = rows[rowIndex];
        const cellPosition = row.cellsPosition[columnIndex];
        if (cellPosition) {
          let mark: string;
          cellPosition.rowIndex = rowIndex;
          cellPosition.columnIndex = columnIndex;

          if (cellPosition.offsetColumn + 1 < cellPosition.cell.colspan) {
            mark = `${rowIndex}*${columnIndex + 1}`;
            if (marks.indexOf(mark) === -1) {
              row.cellsPosition.splice(columnIndex + 1, 0, {
                beforeCell: cellPosition.beforeCell,
                afterCell: cellPosition.afterCell,
                cell: cellPosition.cell,
                row: row.cells,
                rowIndex,
                columnIndex,
                offsetColumn: cellPosition.offsetColumn + 1,
                offsetRow: cellPosition.offsetRow
              });
              marks.push(mark);
            }
          }
          if (cellPosition.offsetRow + 1 < cellPosition.cell.rowspan) {
            mark = `${rowIndex + 1}*${columnIndex}`;
            if (marks.indexOf(mark) === -1) {
              let nextRow = rows[rowIndex + 1];
              if (!nextRow) {
                nextRow = {
                  ...row,
                  cells: [],
                  cellsPosition: []
                };
                rows.push(nextRow);
              }
              const newRowBeforeColumn = nextRow.cellsPosition[columnIndex - 1];
              const newRowAfterColumn = nextRow.cellsPosition[columnIndex];
              nextRow.cellsPosition.splice(columnIndex, 0, {
                beforeCell: newRowBeforeColumn ? newRowBeforeColumn.cell : null,
                afterCell: newRowAfterColumn ? newRowAfterColumn.cell : null,
                row: nextRow.cells,
                cell: cellPosition.cell,
                offsetColumn: cellPosition.offsetColumn,
                offsetRow: cellPosition.offsetRow + 1,
                rowIndex,
                columnIndex,
              });
              marks.push(mark);
            }
          }
          stop = true;
        }
        rowIndex++;
      }
      columnIndex++;
    } while (stop);
    return rows;
  }
}

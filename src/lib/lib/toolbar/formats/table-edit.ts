import { ActionSheetConfig, HandlerType, Priority } from '../help';
import { TableEditActions, TableEditCommander } from '../../commands/table-edit-commander';
import { TableEditHook } from '../hooks/table-edit-hook';

export const tableEditHandler: ActionSheetConfig = {
  type: HandlerType.ActionSheet,
  classes: ['tbus-icon-table-edit'],
  tooltip: '编辑表格',
  hook: new TableEditHook(),
  execCommand: new TableEditCommander(),
  editable: null,
  priority: Priority.Block,
  match: {
    tags: ['td', 'th'],
    noInTags: ['pre']
  },
  actions: [{
    label: '在左边添加列',
    value: TableEditActions.AddColumnToLeft,
    classes: ['tbus-icon-table-add-column-left'],
    keymap: {
      ctrlKey: true,
      shiftKey: true,
      key: 'l'
    }
  }, {
    label: '在右边添加列',
    value: TableEditActions.AddColumnToRight,
    classes: ['tbus-icon-table-add-column-right'],
    keymap: {
      ctrlKey: true,
      shiftKey: true,
      key: 'r'
    }
  }, {
    label: '在上边添加行',
    value: TableEditActions.AddRowToTop,
    classes: ['tbus-icon-table-add-row-top'],
    keymap: {
      ctrlKey: true,
      shiftKey: true,
      key: 'u'
    }
  }, {
    label: '在下边添加行',
    value: TableEditActions.AddRowToBottom,
    classes: ['tbus-icon-table-add-row-bottom'],
    keymap: {
      ctrlKey: true,
      shiftKey: true,
      key: 'd'
    }
  }, {
    label: '删除左边列',
    value: TableEditActions.DeleteLeftColumn,
    classes: ['tbus-icon-table-delete-column-left'],
    keymap: {
      ctrlKey: true,
      altKey: true,
      key: 'l'
    }
  }, {
    label: '删除右边列',
    value: TableEditActions.DeleteRightColumn,
    classes: ['tbus-icon-table-delete-column-right'],
    keymap: {
      ctrlKey: true,
      altKey: true,
      key: 'r'
    }
  }, {
    label: '删除上边行',
    value: TableEditActions.DeleteTopRow,
    classes: ['tbus-icon-table-delete-row-top'],
    keymap: {
      ctrlKey: true,
      altKey: true,
      key: 'u'
    }
  }, {
    label: '删除下边行',
    value: TableEditActions.DeleteBottomRow,
    classes: ['tbus-icon-table-delete-row-bottom'],
    keymap: {
      ctrlKey: true,
      altKey: true,
      key: 'd'
    }
  }, {
    label: '合并单元格',
    value: TableEditActions.MergeCells,
    classes: ['tbus-icon-table-split-columns'],
    keymap: {
      ctrlKey: true,
      altKey: true,
      key: 'm'
    }
  }, {
    label: '取消合并单元格',
    value: TableEditActions.SplitCells,
    classes: ['tbus-icon-table'],
    keymap: {
      ctrlKey: true,
      altKey: true,
      key: 's'
    }
  }]
};

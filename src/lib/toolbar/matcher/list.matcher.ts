import { Type } from '@tanbo/di';

import { Matcher, RangeMatchState, SelectionMatchState } from './matcher';
import { BranchAbstractComponent, DivisionAbstractComponent, TBSelection } from '../../core/_api';
import { ListComponent } from '../../components/list.component';
import { HighlightState } from '../help';
import { rangeContentInComponent } from './utils/range-content-in-component';

export class ListMatcher implements Matcher {
  constructor(private tagName: 'ul' | 'ol',
              private excludeComponents: Array<Type<BranchAbstractComponent | DivisionAbstractComponent>> = []) {
  }

  queryState(selection: TBSelection): SelectionMatchState {
    if (selection.rangeCount === 0) {
      return {
        srcStates: [],
        matchData: null,
        state: HighlightState.Normal
      }
    }

    for (const range of selection.ranges) {
      let isDisable = rangeContentInComponent(range, this.excludeComponents);
      if (isDisable) {
        return {
          state: HighlightState.Disabled,
          matchData: null,
          srcStates: []
        };
      }
    }

    const states = selection.ranges.map<RangeMatchState<ListComponent>>(range => {
      if (range.commonAncestorComponent instanceof ListComponent &&
        range.commonAncestorComponent.tagName === this.tagName) {
        return {
          srcData: range.commonAncestorComponent,
          fromRange: range,
          state: HighlightState.Highlight
        }
      }

      const context = range.commonAncestorFragment.getContext(ListComponent);
      return {
        state: context && context.tagName === this.tagName ? HighlightState.Highlight : HighlightState.Normal,
        srcData: context,
        fromRange: range
      }
    });
    let isHighlight = true;
    for (const item of states) {
      if (item.state === HighlightState.Normal) {
        isHighlight = false;
        break;
      }
    }
    return {
      state: isHighlight ? HighlightState.Highlight : HighlightState.Normal,
      srcStates: states,
      matchData: states[0]?.srcData,
    }
  }
}

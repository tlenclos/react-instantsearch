import algoliasearchHelper, { SearchParameters } from 'algoliasearch-helper';

import createWidgetsManager from './createWidgetsManager';
import createStore from './createStore';
import highlightTags from './highlightTags.js';
import { omit, isEmpty } from 'lodash';

/**
 * Creates a new instance of the InstantSearchManager which controls the widgets and
 * trigger the search when the widgets are updated.
 * @param {string} indexName - the main index name
 * @param {object} initialState - initial widget state
 * @param {object} SearchParameters - optional additional parameters to send to the algolia API
 * @return {InstantSearchManager} a new instance of InstantSearchManager
 */
export default function createInstantSearchManager({
  indexName,
  initialState = {},
  algoliaClient,
  searchParameters = {},
  resultsState,
}) {
  const baseSP = new SearchParameters({
    ...searchParameters,
    index: indexName,
    ...highlightTags,
  });

  const helper = algoliasearchHelper(algoliaClient, indexName, baseSP);
  helper.on('result', handleSearchSuccess);
  helper.on('error', handleSearchError);

  let derivedHelpers = {};
  let indexMapping = {}; // keep track of the original index where the parameters applied when sortBy is used.

  let initialSearchParameters = helper.state;

  const widgetsManager = createWidgetsManager(onWidgetsUpdate);

  const store = createStore({
    widgets: initialState,
    metadata: [],
    results: resultsState || null,
    error: null,
    searching: false,
    searchingForFacetValues: false,
  });

  let skip = false;

  function skipSearch() {
    skip = true;
  }

  function updateClient(client) {
    helper.setClient(client);
    search();
  }

  function clearCache() {
    helper.clearCache();
    search();
  }

  function getMetadata(state) {
    return widgetsManager
      .getWidgets()
      .filter(widget => Boolean(widget.getMetadata))
      .map(widget => widget.getMetadata(state));
  }

  function getSearchParameters() {
    indexMapping = {};
    const sharedParameters = widgetsManager
      .getWidgets()
      .filter(widget => Boolean(widget.getSearchParameters))
      .filter(
        widget =>
          !widget.context.multiIndexContext &&
          (widget.props.indexName === indexName || !widget.props.indexName)
      )
      .reduce(
        (res, widget) => widget.getSearchParameters(res),
        initialSearchParameters
      );
    indexMapping[sharedParameters.index] = indexName;

    const derivatedWidgets = widgetsManager
      .getWidgets()
      .filter(widget => Boolean(widget.getSearchParameters))
      .filter(
        widget =>
          (widget.context.multiIndexContext &&
            widget.context.multiIndexContext.targetedIndex !== indexName) ||
          (widget.props.indexName && widget.props.indexName !== indexName)
      )
      .reduce((indices, widget) => {
        const targetedIndex = widget.context.multiIndexContext
          ? widget.context.multiIndexContext.targetedIndex
          : widget.props.indexName;
        const index = indices.find(i => i.targetedIndex === targetedIndex);
        if (index) {
          index.widgets.push(widget);
        } else {
          indices.push({ targetedIndex, widgets: [widget] });
        }
        return indices;
      }, []);

    const mainIndexParameters = widgetsManager
      .getWidgets()
      .filter(widget => Boolean(widget.getSearchParameters))
      .filter(
        widget =>
          (widget.context.multiIndexContext &&
            widget.context.multiIndexContext.targetedIndex === indexName) ||
          (widget.props.indexName && widget.props.indexName === indexName)
      )
      .reduce(
        (res, widget) => widget.getSearchParameters(res),
        sharedParameters
      );

    return { sharedParameters, mainIndexParameters, derivatedWidgets };
  }

  function search() {
    if (!skip) {
      const {
        sharedParameters,
        mainIndexParameters,
        derivatedWidgets,
      } = getSearchParameters(helper.state);
      Object.keys(derivedHelpers).forEach(key => derivedHelpers[key].detach());
      derivedHelpers = {};

      helper.setState(sharedParameters);

      derivatedWidgets.forEach(derivatedSearchParameters => {
        const index = derivatedSearchParameters.targetedIndex;
        const derivedHelper = helper.derive(() => {
          const parameters = derivatedSearchParameters.widgets.reduce(
            (res, widget) => widget.getSearchParameters(res),
            sharedParameters
          );
          indexMapping[parameters.index] = index;
          return parameters;
        });
        derivedHelper.on('result', handleSearchSuccess);
        derivedHelper.on('error', handleSearchError);
        derivedHelpers[index] = derivedHelper;
      });

      helper.setState(mainIndexParameters);

      helper.search();
    }
  }

  function handleSearchSuccess(content) {
    const state = store.getState();
    let results = state.results ? state.results : {};

    /* if switching from mono index to multi index and vice versa, 
    results needs to reset to {}*/
    results = !isEmpty(derivedHelpers) && results.getFacetByName ? {} : results;

    if (!isEmpty(derivedHelpers)) {
      results[indexMapping[content.index]] = content;
    } else {
      results = content;
    }

    const nextState = omit(
      {
        ...store.getState(),
        results,
        searching: false,
        error: null,
      },
      'resultsFacetValues'
    );
    store.setState(nextState);
  }

  function handleSearchError(error) {
    const nextState = omit(
      {
        ...store.getState(),
        error,
        searching: false,
      },
      'resultsFacetValues'
    );
    store.setState(nextState);
  }

  // Called whenever a widget has been rendered with new props.
  function onWidgetsUpdate() {
    const metadata = getMetadata(store.getState().widgets);

    store.setState({
      ...store.getState(),
      metadata,
      searching: true,
    });

    // Since the `getSearchParameters` method of widgets also depends on props,
    // the result search parameters might have changed.
    search();
  }

  function transitionState(nextSearchState) {
    const searchState = store.getState().widgets;
    return widgetsManager
      .getWidgets()
      .filter(widget => Boolean(widget.transitionState))
      .reduce(
        (res, widget) => widget.transitionState(searchState, res),
        nextSearchState
      );
  }

  function onExternalStateUpdate(nextSearchState) {
    const metadata = getMetadata(nextSearchState);

    store.setState({
      ...store.getState(),
      widgets: nextSearchState,
      metadata,
      searching: true,
    });

    search();
  }

  function onSearchForFacetValues(nextSearchState) {
    store.setState({
      ...store.getState(),
      searchingForFacetValues: true,
    });

    helper
      .searchForFacetValues(nextSearchState.facetName, nextSearchState.query)
      .then(
        content => {
          store.setState({
            ...store.getState(),
            resultsFacetValues: {
              ...store.getState().resultsFacetValues,
              [nextSearchState.facetName]: content.facetHits,
              query: nextSearchState.query,
            },
            searchingForFacetValues: false,
          });
        },
        error => {
          store.setState({
            ...store.getState(),
            error,
            searchingForFacetValues: false,
          });
        }
      )
      .catch(error => {
        // Since setState is synchronous, any error that occurs in the render of a
        // component will be swallowed by this promise.
        // This is a trick to make the error show up correctly in the console.
        // See http://stackoverflow.com/a/30741722/969302
        setTimeout(() => {
          throw error;
        });
      });
  }

  function updateIndex(newIndex) {
    initialSearchParameters = initialSearchParameters.setIndex(newIndex);
    search();
  }

  function getWidgetsIds() {
    return store
      .getState()
      .metadata.reduce(
        (res, meta) =>
          typeof meta.id !== 'undefined' ? res.concat(meta.id) : res,
        []
      );
  }

  return {
    store,
    widgetsManager,
    getWidgetsIds,
    onExternalStateUpdate,
    transitionState,
    onSearchForFacetValues,
    updateClient,
    updateIndex,
    clearCache,
    skipSearch,
  };
}

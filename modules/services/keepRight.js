import _extend from 'lodash-es/extend';
import _find from 'lodash-es/find';
import _forEach from 'lodash-es/forEach';

import rbush from 'rbush';

import { dispatch as d3_dispatch } from 'd3-dispatch';
import { json as d3_json } from 'd3-request';
import { request as d3_request } from 'd3-request';

import { geoExtent, geoVecAdd } from '../geo';
import { services } from './index';
import { krError } from '../osm';

import { utilRebind, utilTiler, utilQsString } from '../util';

var tiler = utilTiler();
var dispatch = d3_dispatch('loaded');

var _krCache;
var _krZoom = 14;
var apibase = 'https://www.keepright.at/';
var defaultRuleset = [0,30,40,50,70,90,100,110,120,130,150,160,170,180,191,192,193,194,195,196,197,198,201,202,203,204,205,206,207,208,210,220,231,232,270,281,282,283,284,285,291,292,293,294,295,296,297,298,311,312,313,320,350,370,380,401,402,411,412,413];

function abortRequest(i) {
    if (i) {
        i.abort();
    }
}

function abortUnwantedRequests(cache, tiles) {
    _forEach(cache.inflight, function(v, k) {
        var wanted = _find(tiles, function(tile) {
            return k === tile.id;
        });
        if (!wanted) {
            abortRequest(v);
            delete cache.inflight[k];
        }
    });
}


function encodeErrorRtree(d) {
    return { minX: d.loc[0], minY: d.loc[1], maxX: d.loc[0], maxY: d.loc[1], data: d };
}


// replace or remove error from rtree
function updateRtree(item, replace) {
    _krCache.rtree.remove(item, function isEql(a, b) {
        return a.data.id === b.data.id;
    });

    if (replace) {
        _krCache.rtree.insert(item);
    }
}


export default {
    init: function() {
        if (!_krCache) {
            this.reset();
        }

        this.event = utilRebind(this, dispatch, 'on');
    },

    reset: function() {
        if (_krCache) {
            _forEach(_krCache.inflight, abortRequest);
        }
        _krCache = { loaded: {}, inflight: {}, keepRight: {}, rtree: rbush() };
    },


    // KeepRight API:  http://osm.mueschelsoft.de/keepright/interfacing.php
    loadErrors: function(context, projection) {
        var options = {
            format: 'geojson'
        };
        var rules = defaultRuleset.join();
        var that = this;

        // determine the needed tiles to cover the view
        var tiles = tiler
            .zoomExtent([_krZoom, _krZoom])
            .getTiles(projection);

        // abort inflight requests that are no longer needed
        abortUnwantedRequests(_krCache, tiles);

        // issue new requests..
        tiles.forEach(function(tile) {
            if (_krCache.loaded[tile.id] || _krCache.inflight[tile.id]) return;

            var rect = tile.extent.rectangle();
            var params = _extend({}, options, { left: rect[0], bottom: rect[3], right: rect[2], top: rect[1] });
            var url = apibase + 'export.php?' + utilQsString(params) + '&ch=' + rules;

            _krCache.inflight[tile.id] = d3_json(url,
                function(err, data) {
                    delete _krCache.inflight[tile.id];

                    if (err) return;
                    _krCache.loaded[tile.id] = true;

                    if (!data.features || !data.features.length) return;

                    data.features.forEach(function(feature) {
                        var loc = feature.geometry.coordinates;
                        var props = feature.properties;

                        // - move markers slightly so it doesn't obscure the geometry,
                        // - then move markers away from other coincident markers
                        var coincident = false;
                        var epsilon = 0.00001;
                        do {
                            // first time, move marker up. after that, move marker right.
                            var delta = coincident ? [epsilon, 0] : [0, epsilon];
                            loc = geoVecAdd(loc, delta);
                            var bbox = geoExtent(loc).bbox();
                            coincident = _krCache.rtree.search(bbox).length;
                        } while (coincident);

                        var d = new krError({
                            loc: loc,
                            id: props.error_id,
                            comment: props.comment || null,
                            description: props.description || '',
                            error_id: props.error_id,
                            error_type: props.error_type,
                            object_id: props.object_id,
                            object_type: props.object_type,
                            schema: props.schema,
                            title: props.title
                        });

                        _krCache.keepRight[d.id] = d;
                        _krCache.rtree.insert(encodeErrorRtree(d));
                    });

                    dispatch.call('loaded');
                }
            );
        });
    },


    postKeepRightUpdate: function(update, callback) {
        if (!services.osm.authenticated()) {
            return callback({ message: 'Not Authenticated', status: -3 }, update);
        }
        if (_krCache.inflight[update.id]) {
            return callback(
                { message: 'Error update already inflight', status: -2 }, update);
        }

        var path = apibase + 'comment.php?';
        if (update.state) {
            path += '&st=' + update.state;
        }
        if (update.newComment) {
            path += '&' + utilQsString({ co: update.newComment });
        }

        path += '&schema=' + update.schema + '&id=' + update.error_id;

        _krCache.inflight[update.id] = d3_request(path)
            .mimeType('application/json')
            .response(function(xhr) {
                return JSON.parse(xhr.responseText);
            })
            .post(function(err, data) {
                delete _krCache.inflight[update.id];
                if (err) { return callback(err); }

                console.log('data ', data);
            });

        // NOTE: This throws a CORS error, but it seems successful?
    },


    // get all cached errors covering the viewport
    getErrors: function(projection) {
        var viewport = projection.clipExtent();
        var min = [viewport[0][0], viewport[1][1]];
        var max = [viewport[1][0], viewport[0][1]];
        var bbox = geoExtent(projection.invert(min), projection.invert(max)).bbox();

        return _krCache.rtree.search(bbox).map(function(d) {
            return d.data;
        });
    },

    // get a single error from the cache
    getError: function(id) {
        return _krCache.keepRight[id];
    },

    // replace a single error in the cache
    replaceError: function(error) {
        if (!(error instanceof krError) || !error.id) return;

        _krCache.keepRight[error.id] = error;
        updateRtree(encodeErrorRtree(error), true); // true = replace
        return error;
    },

    // remove a single error from the cache
    removeError: function(error) {
        if (!(error instanceof krError) || !error.id) return;

        delete _krCache.keepRight[error.id];
        updateRtree(encodeErrorRtree(error), false); // false = remove
    }
};

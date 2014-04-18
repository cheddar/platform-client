// == BSD2 LICENSE ==
// Copyright (c) 2014, Tidepool Project
//
// This program is free software; you can redistribute it and/or modify it under
// the terms of the associated License, which is identical to the BSD 2-Clause
// License as published by the Open Source Initiative at opensource.org.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
// FOR A PARTICULAR PURPOSE. See the License for more details.
//
// You should have received a copy of the License along with this program; if
// not, you can obtain one from Tidepool Project at tidepool.org.
// == BSD2 LICENSE ==

'use strict';

var moment = (typeof window !== 'undefined' && typeof window.moment !== 'undefined') ? window.moment : require('moment');
var _ = (typeof window !== 'undefined' && typeof window._ !== 'undefined') ? window._ : require('lodash');
var Rx = (typeof window !== 'undefined' && typeof window.Rx !== 'undefined') ? window.Rx : require('rx');

// Require it so that it gets registered
require('../rx/selfjoin.js');

function isScheduledBasal(e) {
  return e.type === 'basal' && e.deliveryType === 'scheduled';
}

var keysForEquality = ['start', 'end', 'value', 'percent', 'duration', 'deliveryType'];

function makeNewBasalHandler() {
  var segmentStart = null;
  var eventBuffer = [];

  function makeSegment(event) {
    return _.assign(
      {},
      segmentStart,
      {
        type: 'basal-rate-segment',
        start: segmentStart.deviceTime,
        end: event == null ? null : event.deviceTime
      }
    );
  }

  return {
    completed: function() {
      return [makeSegment()].concat(eventBuffer);
    },
    handle: function (event) {
      if (! isScheduledBasal(event)) {
        eventBuffer.push(event);
        return null;
      }

      if (segmentStart == null) {
        segmentStart = event;
      } else if (segmentStart.deviceId !== event.deviceId) {
        eventBuffer.push(event);
        return null;
      } else if (_.isEqual(_.pick(segmentStart, keysForEquality), _.pick(event, keysForEquality))) {
        // Ignore the basal if it's the same
        return null;
      } else {
        return [makeSegment(event)].concat(eventBuffer, [event]);
      }
    }
  };
}

if (Rx.Observable.prototype.tidepoolConvertBasal == null) {
  /**
   * A function that does a self-join on the provided eventStream (an Observable) in order to join together
   * basal records.

   * @param eventStream an Observable to have its bolus events self-joined.
   */
  Rx.Observable.prototype.tidepoolConvertBasal = function () {
    return this.tidepoolSelfJoin(
      [
        function(e){
          // Only join together carelink basals.  This is a hack to work around the question of
          // having a "duration" on basals.  Once we have the tidepool data format defined, this
          // should be revisited.
          if (e.source !== 'carelink') {
            return null;
          }

          return isScheduledBasal(e) ? makeNewBasalHandler() : null;
        }
      ]
    ).tidepoolSelfJoin(
      [
        function(event) {
          if (! (event.type === 'basal' && event.deliveryType === 'temp')) {
            return null;
          }

          var temp = null;
          var eventBuffer = [];
          return {
            handle: function(e) {
              if (temp == null) {
                temp = _.assign({}, e, {
                  type: 'basal-rate-segment',
                  start: e.deviceTime,
                  end: moment(e.deviceTime).add('ms', e.duration).format('YYYY-MM-DDTHH:mm:ss')
                });
                return null;
              }

              if (e.type === 'basal') {
                if (temp.end < e.deviceTime) {
                  // Exceeded the length of the temp, so just return
                  return [temp].concat(eventBuffer).concat([e]);
                } else if (e.deliveryType === 'temp-stop' && e.tempId === temp.id) {
                  // We have a canceled temp basal
                  temp.end = e.deviceTime;
                  return [temp].concat(eventBuffer);
                }
              }

              eventBuffer.push(e);
              return null;
            },
            completed: function() {
              return [temp].concat(eventBuffer);
            }
          };
        }
      ])
      .map(function(e) {
        if (! (e.type === 'basal' && e.source === 'diasend')) {
          return e;
        }

        return _.assign(
          {},
          e,
          {
            type: 'basal-rate-segment',
            start: e.deviceTime,
            end: moment(e.deviceTime).clone().add('ms', e.duration).format('YYYY-MM-DDTHH:mm:ss')
          }
        );
      });
  };
}

module.exports = function(eventStream) {
  return eventStream.tidepoolConvertBasal();
};

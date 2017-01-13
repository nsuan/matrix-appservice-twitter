const log  = require('../logging.js');

const STREAM_RETRY_INTERVAL = 5000;
const BACKOFF_NOTIFY_USER_AT = (1000*60*2);
const STREAM_LOCKOUT_RETRY_INTERVAL = 60*60*1000;
const TWEET_REPLY_MAX_DEPTH = 0;

class UserStream {
  constructor (twitter) {
    this.twitter = twitter;
    this._user_streams = new Map();
    this._backoff = new Map();
  }

  attach_all () {
    log.info("Attaching all authenticated users.");
    this.twitter.storage.get_linked_user_ids().then((ids) =>{
      ids.forEach((id) => {
        this.attach(id);
      });
    });
  }

  /**
   * Start reading live updates from a Twitter User Stream.
   *
   * @param  {string} user_id The user's matrix ID.
   * @return {Promise}   A Promise that will resolve with the operation completes.
   */
  attach (user_id) {
    if(this._user_streams.has(user_id)) {
      log.warn("Not attaching stream since we already have one connected!");
      return;
    }

    this._user_streams.set(user_id, "pending");//Block race attempts;
    var client;
    return this.twitter.client_factory.get_client(user_id).then((c) => {
      if(!c) {
        this._user_streams.delete(user_id);
        throw "get_client didn't resolve to a client, so something's up.";
      }
      client = c;
      return this.twitter.storage.get_timeline_room(user_id);
    }).then(room => {
      if(room == null) {
        this._user_streams.delete(user_id);
        throw "User has no attached timeline room. This is probably a bug.";
      }
      var stream = client.stream('user', {with: room.with, replies: room.replies});
      stream.on('data',  (data) => {
        if(this._backoff.has(user_id)) {
          this._backoff.delete(user_id);
        }
        this._on_stream_data(user_id, data);
      });
      stream.on('error', (error) => {
        const backoff =  2 * (this._backoff.has(user_id) ? this._backoff.get(user_id) : STREAM_RETRY_INTERVAL/2);
        this._backoff.set(user_id, backoff);
        if (backoff >= BACKOFF_NOTIFY_USER_AT) {
          this.twitter.notify_matrix_user(user_id,
            `Currently experiencing connection issues with Twitter. Will retry to connect in ${backoff/1000} seconds.
            If this continues, notify the bridge maintainer.`);
        }
        this.detach(user_id);
        setTimeout(() => {this.attach(user_id); }, backoff);
        log.error(
          "Stream gave an error %s. Detaching for %s seconds for %s.", error, backoff/1000, user_id
        );
      });
      this._user_streams.set(user_id, stream);
      log.info("Attached stream for " + user_id);
    }).catch( err => {
      log.error(
        "Stream could not be attached for user %s: %s", user_id, err
      );
    });
  }

  detach (user_id) {
    if(this._user_streams.has(user_id)) {
      this._user_streams.get(user_id).destroy();
      this._user_streams.delete(user_id);
      log.info("Detached stream for ", user_id);
    }
  }

  detach_all () {
    this._user_streams.forEach((item, i) =>{
      this.detach(i);
    });
  }

  _on_stream_data (user_id, data) {
    if(data.direct_message) {
      this.twitter.dm.process_dm(data.direct_message);
    }
    else if (data.warning) {
      log.warn("Got a warning from a User Stream.\n%s : %s",
        data.warning.code,
        data.warning.message
      );
    }
    else if (data.disconnect) {
      this._handle_disconnect(user_id, data);
    }
    else if(data.event) {
      this._process_event(data);
    }
    else if (data.id) { //Yeah..the only way to know if it's a tweet is to check if the ID field is set at the root level.
      let client;
      this.twitter.client_factory.get_client(user_id).then((c) =>{
        client = c;
        return this.twitter.storage.get_timeline_room(user_id);
      }).then((room) =>{
        if(room !== null) {
          this.twitter.processor.process_tweet(room.room_id, data, TWEET_REPLY_MAX_DEPTH, client);
        }
        else{
          log.verbose(`${user_id} does not have a registered timeline view for their stream.`);
        }
      }).catch((err) =>{
        log.error("There was error sending a userstream tweet into a timeline room. %s", err);
      });
    }
    else {
      log.verbose("Unknown Stream Data (%s)", Object.keys(data).join(', '));
    }
  }

  _handle_disconnect (user_id, data) {
    if(data.disconnect.code === 2) {
      log.error("Disconnect error for too many duplicate streams. Bailing on this user.\n%s",
        data.warning.message
      );
      this.detach(user_id);
      setTimeout(() => {this.attach(user_id); }, STREAM_LOCKOUT_RETRY_INTERVAL);
      this.twitter.notify_matrix_user(
         user_id,
         "We had an issue connecting to your Twitter account. Services may be distrupted"
       );
    }
    else if(data.disconnect.code === 6 ) {
      log.error("Token revoked. We can't do any more here.\n%s",
       data.warning.message);
    }
    else
    {
      log.warn("Disconnect errorcode %s %s. Restarting stream.",
        data.warning.code,
        data.warning.message
      );
      this.detach(user_id);
      setTimeout(() => {this.attach(user_id); }, STREAM_RETRY_INTERVAL);
    }
  }

  _process_event (data) {
    log.verbose("Got unknown event %s", data.event);
  }

}

module.exports = UserStream;

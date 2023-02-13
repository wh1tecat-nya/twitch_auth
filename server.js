const path = require("path");
const express = require("express");
const {
  exchangeCode,
  RefreshingAuthProvider,
  getTokenInfo,
  revokeToken,
} = require("@twurple/auth");
const { ApiClient } = require("@twurple/api");
const { EventSubWsListener } = require("@twurple/eventsub-ws");
const sqlite3 = require("sqlite3");
const sqlite = require("sqlite");
const schedule = require("node-schedule");
const { v4: uuidv4 } = require("uuid");

require("dotenv").config();

const CLIENT_ID = process.env.CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? "";

const app = express();
const port = 8080;

const main = async () => {
  const db = await sqlite.open({
    filename: path.resolve("db", "index.db"),
    driver: sqlite3.Database,
  });

  app.use(
    express.raw({
      type: "application/json",
    })
  );
  app.use(express.static("html"));

  app.get("/", (req, res) => {
    return res.status(200).sendFile(path.resolve("index.html"));
  });

  app.get("/register", async (req, res) => {
    console.log("incoming register request");
    const { code, scope } = req.query;

    if (!code || !scope || typeof code !== "string") {
      return res.status(400).send("some parameter is wrong");
    }
    if (scope !== "moderator:manage:shoutouts") {
      return res.status(400).send("scope is wrong");
    }

    const exchangeResult = await exchangeCode(
      CLIENT_ID,
      CLIENT_SECRET,
      code,
      "https://twitch-auth.wh1te.cat/register"
    ).catch((e) => {
      console.log(e);
      return false;
    });

    if (typeof exchangeResult === "boolean") {
      return res.status(400).send("failed to get token");
    }

    const { uuid, userId, userName } = await registTokenToDb(exchangeResult, false);

    console.log(`request user:${userName} id:${userId} register_id:${uuid}`);

    const authProvider = await registAuthProvider(exchangeResult, userName, userId);
    const apiClient = new ApiClient({ authProvider });

    await apiClient.eventSub.deleteAllSubscriptions().catch((e) => console.log(e));
    await registerRaidHandler(apiClient, userId);

    return res.redirect(301, `/registered?regId=${uuid}&name=${userName}`);
  });

  app.get("/registered", (req, res) => {
    return res.status(200).sendFile(path.resolve("html", "registered.html"));
  });

  app.get("/unregister", async (req, res) => {
    console.log("incoming unregister request");
    const { registered_id: registeredId } = req.query;

    if (!registeredId) {
      console.log("registered_id not found");
      return res.redirect(
        301,
        "https://id.twitch.tv/oauth2/authorize?client_id=amy5xm2qna81y2wc699391xi1unhhu&redirect_uri=https://twitch-auth.wh1te.cat/unregisterWithLogin&response_type=code"
      );
    }

    const token = await db.get(
      'select * from "main"."token" where "registerId" = ?',
      registeredId
    );

    if (!token) {
      console.log("token not found");
      return res.redirect(
        301,
        "https://id.twitch.tv/oauth2/authorize?client_id=amy5xm2qna81y2wc699391xi1unhhu&redirect_uri=https://twitch-auth.wh1te.cat/unregisterWithLogin&response_type=code"
      );
    }

    const { accessToken, userName, userId, isActive } = token;
    const authProvider = await registAuthProvider(token, userName, userId);
    const apiClient = new ApiClient({ authProvider });

    if (!isActive) {
      console.log("token is already disabled");
      return res.status(400).sendFile(path.resolve("html", "not_registered.html"));
    }

    await db.run('update "main"."token" set "isActive" = 0 where "userId" = ?', userId);
    await db.run(
      'update "main"."raid" set "isDoneShoutout" = 1 where "toId" = ?',
      userId
    );

    await apiClient.eventSub.deleteAllSubscriptions().catch((e) => console.log(e));
    await revokeToken(CLIENT_ID, accessToken);

    return res.status(200).sendFile(path.resolve("html", "unregistered.html"));
  });

  app.get("/unregisterWithLogin", async (req, res) => {
    console.log("incoming unregisterWithLogin request");
    const { code } = req.query;

    if (!code || typeof code !== "string") {
      return res.status(400).send("parameter is wrong");
    }

    const exchangeResult = await exchangeCode(
      CLIENT_ID,
      CLIENT_SECRET,
      code,
      "https://twitch-auth.wh1te.cat/register"
    ).catch((e) => {
      console.log(e);
      return false;
    });

    if (typeof exchangeResult === "boolean") {
      return res.status(400).send("failed to get token");
    }

    const { accessToken } = exchangeResult;
    const { userId, userName } = await getTokenInfo(accessToken, CLIENT_ID);

    const token = await db.get('select * from "main"."token" where "userId" = ?', userId);

    if (!token) {
      console.log("token not found");
      return res.status(400).sendFile(path.resolve("html", "not_registered.html"));
    }

    const { isActive } = token;

    await registTokenToDb(exchangeResult, true);

    const authProvider = await registAuthProvider(exchangeResult, userName, userId);
    const apiClient = new ApiClient({ authProvider });

    if (!isActive) {
      console.log("token is already disabled");
      return res.status(400).sendFile(path.resolve("html", "not_registered.html"));
    }

    await db.run('update "main"."token" set "isActive" = 0 where "userId" = ?', userId);
    await db.run(
      'update "main"."raid" set "isDoneShoutout" = 1 where "toId" = ?',
      userId
    );

    await apiClient.eventSub.deleteAllSubscriptions().catch((e) => console.log(e));
    await revokeToken(CLIENT_ID, accessToken);

    return res.status(200).sendFile(path.resolve("html", "unregistered.html"));
  });

  app.get("/status", async (req, res) => {
    console.log("incoming check status request");
    const { registered_id: registeredId } = req.query;
    const token = await db.get(
      'select * from "main"."token" where "registerId" = ?',
      registeredId
    );

    if (!token) {
      return res.status(200).send(JSON.stringify({ status: "unregistered" }));
    }

    console.log(`user:${token.userName} current status:${token.isActive}`);

    return res
      .status(200)
      .send(
        JSON.stringify({ status: token?.isActive ?? "disabled" ? "active" : "disabled" })
      );
  });

  app.listen(port, () => {
    console.log(`listening at http://localhost:${port}`);
  });

  const registeredUser = await db.all(
    `select * from "main"."token" where "isActive" = 1`
  );

  for (const token of registeredUser) {
    const { userName, userId } = token;
    const authProvider = await registAuthProvider(token, userName, userId);
    const apiClient = new ApiClient({ authProvider });

    await apiClient.eventSub.deleteAllSubscriptions().catch((e) => console.log(e));

    await registerRaidHandler(apiClient, token.userId).catch((e) => console.log(e));
  }

  schedule.scheduleJob("*/30 * * * * *", async () => {
    const undoneSendRaids = await db.all(
      'select * from "main"."raid" where "isDoneShoutout" = false group by "toId" order by date("date") desc'
    );

    console.log(`undoneSendRaids:${undoneSendRaids.length}`);

    const raidedCasterIds = undoneSendRaids.map((raid) => raid.toId);
    const tokens = await db.all(
      `select * from "main"."token" where "userId" in (${raidedCasterIds.join(",")})`
    );

    for (const raid of undoneSendRaids) {
      const { id, fromId, fromName, toId, toName, date } = raid;
      const token = tokens.find((token) => token.userId === toId);

      const authProvider = await registAuthProvider(token, token.userName, token.userId);
      const apiClient = new ApiClient({ authProvider });

      const isDoneShoutout = await sendShoutout(apiClient, toId, fromId, toId);

      if (!isDoneShoutout) {
        console.log(
          `failed shoutout. state not changed. from:${fromName} to:${toName} date:${date}`
        );
        continue;
      }

      console.log(`success shoutout. from:${fromName} to:${toName} date:${date}`);
      db.run(
        `update "main"."raid" set \
          "isDoneShoutout" = 1 \
          where "id" = ?`,
        id
      );
    }
  });

  async function registTokenToDb(exchangeResult, isUnregist) {
    const { accessToken, expiresIn, refreshToken, obtainmentTimestamp } = exchangeResult;

    const { userId, userName } = await getTokenInfo(accessToken, CLIENT_ID);
    const uuid = uuidv4();

    db.run(
      `insert into "main"."token" \
      ("userId", "userName", "registerId", "accessToken", "refreshToken", "expiresIn", "obtainmentTimestamp", "isActive") \
      values \
      (?, ?, ?, ?, ?, ?, ?, 1) \
      on conflict("userId") do update set \
      "userName" = ?, 
      ${
        isUnregist ? "" : '"registerId" = ?, '
      }"accessToken" = ?, "refreshToken" = ?, "expiresIn" = ?, "obtainmentTimestamp" = ?${
        isUnregist ? "" : ', "isActive" = ?'
      }`,
      ...[
        userId,
        userName,
        uuid,
        accessToken,
        refreshToken,
        expiresIn,
        obtainmentTimestamp,
        userName,
        ...(isUnregist ? [] : [uuid]),
        accessToken,
        refreshToken,
        expiresIn,
        obtainmentTimestamp,
        ...(isUnregist ? [] : [1]),
      ]
    );

    return { uuid, userId, userName };
  }

  async function registAuthProvider(exchangeResult, userName, userId) {
    const { expiresIn, refreshToken, obtainmentTimestamp: timeStamp } = exchangeResult;

    const refreshAuthProvider = new RefreshingAuthProvider(
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        onRefresh: (token) => {
          console.log(`token refreshed. userName:${userName} userId:${userId}`);
          const { accessToken, refreshToken, expiresIn, obtainmentTimestamp } = token;

          db.run(
            `update "main"."token" set \
            "accessToken" = ?, "refreshToken" = ?, "expiresIn" = ?, "obtainmentTimestamp" = ? \
            where "userId" = ?`,
            ...[accessToken, refreshToken, expiresIn, obtainmentTimestamp, userId]
          );
        },
      },
      { refreshToken, expiresIn, obtainmentTimestamp: timeStamp }
    );
    return refreshAuthProvider;
  }

  async function registerRaidHandler(apiClient, userId) {
    const listener = new EventSubWsListener({ apiClient });

    listener.subscribeToChannelRaidEventsTo(userId, async (e) => {
      console.log(`from:${e.raidingBroadcasterDisplayName} id:${e.raidingBroadcasterId}`);
      console.log(`to:${e.raidedBroadcasterDisplayName} id:${e.raidedBroadcasterId}`);

      await db.run(
        `insert into "main"."raid" \
        ("fromId", "fromName", "toId", "toName", "date", "isDoneShoutout") \
        values \
        (?, ?, ?, ?, datetime("now", "+9 hours"), 0)`,
        e.raidingBroadcasterId,
        e.raidingBroadcasterDisplayName,
        userId,
        e.raidedBroadcasterDisplayName
      );

      console.log("register shoutout");
    });

    await listener.start();

    console.log("registered Raid Handler");
  }

  async function sendShoutout(
    apiClient,
    fromRaidBroadCasterId,
    toRaidBroadCasterId,
    moderatorId = toRaidBroadCasterId
  ) {
    try {
      await apiClient.callApi({
        type: "helix",
        url: "chat/shoutouts",
        method: "POST",
        query: {
          from_broadcaster_id: fromRaidBroadCasterId,
          to_broadcaster_id: toRaidBroadCasterId,
          moderator_id: moderatorId,
        },
      });
    } catch (e) {
      console.log(e);
      return false;
    }
    return true;
  }
};

main();

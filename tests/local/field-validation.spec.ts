import { test, expect } from "@playwright/test";

const PW = process.env.SITE_PASSWORD;
const E2E_TARGET = process.env.E2E_BASE || "http://localhost:3000";
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
  E2E_TARGET,
);

const getAuthHeaders = async (request: any) => {
  const state = await request.storageState();
  const csrf =
    state.cookies.find((c: any) => c.name === "app_csrf")?.value || "";
  return {
    "X-CSRF-Token": csrf,
    "Content-Type": "application/json",
  };
};

test.describe("location creation field validation", () => {
  test("POST with missing title returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    expect(res.status()).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("required");
  });

  test("POST with missing date_label returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    expect(res.status()).toBe(400);
  });

  test("POST with missing lat returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lng: 0,
        category: "everyday",
      },
    });
    expect(res.status()).toBe(400);
  });

  test("POST with missing lng returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        category: "everyday",
      },
    });
    expect(res.status()).toBe(400);
  });

  test("POST with lat=null returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const res = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: null,
        lng: 0,
        category: "everyday",
      },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("location update field validation", () => {
  test("PATCH with empty title after trim returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { title: "   " },
      });
      expect(res.status()).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("cannot be empty");
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });

  test("PATCH with lat > 90 returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { lat: 91 },
      });
      expect(res.status()).toBe(400);
      const json = await res.json();
      expect(json.error).toContain("lat");
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });

  test("PATCH with lng < -180 returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { lng: -181 },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });

  test("PATCH with invalid category returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { category: "invalid_category" },
      });
      expect(res.status()).toBe(400);
      const json = await res.json();
      expect(json.error).toBeTruthy();
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });

  test("PATCH with empty string category returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { category: "" },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });
});

test.describe("photo_offsets validation", () => {
  test("PATCH with empty string key in photo_offsets returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { photo_offsets: { "": { x: 0, y: 0 } } },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });

  test("PATCH with key > 256 chars in photo_offsets returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const longKey = "a".repeat(300);
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { photo_offsets: { [longKey]: { x: 0, y: 0 } } },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });

  test("PATCH with tab/newline keys in photo_offsets returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { photo_offsets: { "\t\n": { x: 0, y: 0 } } },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });

  test("PATCH with null/non-string value in photo_offsets returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { photo_offsets: { key: null } },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });
});

test.describe("photo_lqips validation", () => {
  test("PATCH with foreign key in photo_lqips returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: {
          photo_lqips: { "foreign-key": "data:image/jpeg;base64,..." },
        },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });

  test("PATCH with non-data-uri value in photo_lqips returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { photo_lqips: { [locId + "-photo"]: "not-a-data-uri" } },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });

  test("PATCH with oversized data-uri in photo_lqips returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const oversizedUri = "data:image/jpeg;base64," + "a".repeat(5000);
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { photo_lqips: { [locId + "-photo"]: oversizedUri } },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });

  test("PATCH with non-string value in photo_lqips returns 400", async ({
    request,
    baseURL,
    context,
  }) => {
    test.skip(!PW || !IS_LOCAL, "needs SITE_PASSWORD and localhost");
    const base = baseURL || "http://localhost:3000";

    await request.post(`${base}/api/auth`, { data: { password: PW } });
    const headers = await getAuthHeaders(request);

    const locRes = await request.post(`${base}/api/locations`, {
      headers,
      data: {
        title: "__pw_field_validation__",
        date_label: "2020-01-01",
        lat: 0,
        lng: 0,
        category: "everyday",
      },
    });
    const locId = (await locRes.json()).id;

    try {
      const res = await request.patch(`${base}/api/locations/${locId}`, {
        headers,
        data: { photo_lqips: { [locId + "-photo"]: 12345 } },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${base}/api/locations/${locId}`, { headers });
    }
  });
});

import { describe, expect, it } from "vitest";
import { networkFor } from "../../src/managed/network.js";

const networks = [
  { name: "bridge", subnets: ["172.17.0.0/16"] },
  { name: "host", subnets: [] },
  { name: "hattisar_default", subnets: ["172.20.0.0/16", "fd00:1::/64"] },
  { name: "other_default", subnets: ["192.168.96.0/20"] },
];

describe("networkFor", () => {
  it("finds the network whose subnet holds one of the addresses", () => {
    expect(networkFor(networks, ["127.0.0.1", "172.20.0.7"])).toBe("hattisar_default");
  });

  it("matches on prefixes that are not byte aligned", () => {
    expect(networkFor(networks, ["192.168.100.3"])).toBe("other_default");
    expect(networkFor(networks, ["192.168.112.3"])).toBeUndefined();
  });

  it("ignores IPv6 subnets and addresses", () => {
    expect(networkFor(networks, ["fd00:1::5"])).toBeUndefined();
  });

  it("returns undefined when no subnet matches", () => {
    expect(networkFor(networks, ["10.0.0.4"])).toBeUndefined();
  });
});

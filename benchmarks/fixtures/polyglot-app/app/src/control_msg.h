#pragma once

struct ControlMessage {
  int type;
};

bool control_msg_serialize(const struct ControlMessage *msg);

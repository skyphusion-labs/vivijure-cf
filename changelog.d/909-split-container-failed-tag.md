### fix(finish): subtitle and film-titles name an HTTP refusal and a handler refusal apart

Both modules tagged two different container failures `passthrough:container-failed`: a non-2xx answer, and a 2xx whose body said `ok: false`. The tag that explains a degrade could not say whether to look at the transport or at the handler. A non-2xx is now `passthrough:container-http-error`, and an `ok: false` body is `passthrough:container-refused`. The `failure` verdict is unchanged (`failureFromStatus` for the first, permanent `refused` for the second). subtitle 0.2.2, film-titles 0.2.2.
